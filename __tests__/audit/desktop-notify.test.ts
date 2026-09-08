// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { notifyDesktop, resolveBusPath } from "@/src/audit/desktop-notify";

// A stand-in for the session bus: it speaks the SASL handshake, answers Hello,
// and then either returns an id or an error — enough to exercise every branch
// of the encoder against a real socket rather than a mock of one.
interface FakeBus {
  path: string;
  server: Server;
  /** Every complete METHOD_CALL body the client sent, raw. */
  calls: Buffer[];
  close(): Promise<void>;
}

function methodReturn(replySerial: number, id: number): Buffer {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const pad8 = (b: Buffer) => { const p = (8 - (b.length % 8)) % 8; return p ? Buffer.concat([b, Buffer.alloc(p)]) : b; };
  // REPLY_SERIAL(5,u) then SIGNATURE(8,g "u")
  const f1 = pad8(Buffer.concat([Buffer.from([5, 1, 0x75, 0]), u32(replySerial)]));
  const f2 = pad8(Buffer.concat([Buffer.from([8, 1, 0x67, 0]), Buffer.from([1]), Buffer.from("u"), Buffer.from([0])]));
  const fields = Buffer.concat([f1, f2]);
  const header = Buffer.concat([Buffer.from([0x6c, 2, 0, 1]), u32(4), u32(99), u32(fields.length)]);
  return Buffer.concat([pad8(Buffer.concat([header, fields])), u32(id)]);
}

function errorReply(replySerial: number, name: string): Buffer {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const pad8 = (b: Buffer) => { const p = (8 - (b.length % 8)) % 8; return p ? Buffer.concat([b, Buffer.alloc(p)]) : b; };
  const str = (v: string) => { const body = Buffer.from(v); const o = Buffer.concat([u32(body.length), body, Buffer.from([0])]); const p = (4 - (o.length % 4)) % 4; return p ? Buffer.concat([o, Buffer.alloc(p)]) : o; };
  const f1 = pad8(Buffer.concat([Buffer.from([4, 1, 0x73, 0]), str(name)]));   // ERROR_NAME
  const f2 = pad8(Buffer.concat([Buffer.from([5, 1, 0x75, 0]), u32(replySerial)]));
  const fields = Buffer.concat([f1, f2]);
  const header = Buffer.concat([Buffer.from([0x6c, 3, 0, 1]), u32(0), u32(98), u32(fields.length)]);
  return Buffer.concat([pad8(Buffer.concat([header, fields]))]);
}

function startBus(
  dir: string,
  behaviour: "ok" | "no-server" | "reject-auth" | "silent",
  id = 4242,
): Promise<FakeBus> {
  const path = join(dir, "bus");
  const calls: Buffer[] = [];
  const server = createServer((sock: Socket) => {
    let authed = false;
    let sawHello = false;
    sock.on("data", (chunk: Buffer) => {
      const text = chunk.toString("latin1");
      if (!authed) {
        if (behaviour === "reject-auth") { sock.write("REJECTED EXTERNAL\r\n"); return; }
        if (text.includes("AUTH")) { authed = true; sock.write("OK 1234deadbeef\r\n"); return; }
        return;
      }
      if (behaviour === "silent") return;
      // BEGIN + Hello may arrive coalesced with the AUTH ack's reply.
      if (!sawHello) { sawHello = true; sock.write(methodReturn(1, 0)); return; }
      calls.push(Buffer.from(chunk));
      sock.write(behaviour === "no-server"
        ? errorReply(2, "org.freedesktop.DBus.Error.ServiceUnknown")
        : methodReturn(2, id));
    });
    sock.on("error", () => { /* client hangs up after its answer */ });
  });
  return new Promise((res) => {
    server.listen(path, () => res({
      path, server, calls,
      close: () => new Promise<void>((r) => server.close(() => r())),
    }));
  });
}

let dir: string;
let bus: FakeBus | null = null;
let bus2: FakeBus | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fp-dbus-")); });
afterEach(async () => { await bus?.close(); bus = null; await bus2?.close(); bus2 = null; rmSync(dir, { recursive: true, force: true }); });

describe("resolving the bus address", () => {
  it("constructs one from the uid when the environment has none", () => {
    // The scheduled audit's case: a child of a system service started at boot,
    // whose environment carries no DBUS_SESSION_BUS_ADDRESS at all. This is
    // exactly why the address is built rather than read.
    expect(resolveBusPath({})).toBe(`/run/user/${process.getuid!()}/bus`);
  });

  it("prefers a declared address, because on an unusual setup it is the only right one", () => {
    expect(resolveBusPath({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/odd/bus" })).toBe("/tmp/odd/bus");
    expect(resolveBusPath({ DBUS_SESSION_BUS_ADDRESS: "unix:guid=abc,path=/tmp/g/bus" })).toBe("/tmp/g/bus");
  });

  it("falls back rather than dialing an address form it cannot open", () => {
    // `unix:abstract=` and `tcp:` are legal and unsupported here. Reporting
    // "no session" beats connecting somewhere wrong.
    for (const addr of ["unix:abstract=/tmp/dbus-xyz", "tcp:host=localhost,port=1", "garbage"]) {
      expect(resolveBusPath({ DBUS_SESSION_BUS_ADDRESS: addr })).toBe(`/run/user/${process.getuid!()}/bus`);
    }
  });
});

describe("posting a notification", () => {
  it("completes the handshake and reads back the id the server assigned", async () => {
    bus = await startBus(dir, "ok", 77);
    const out = await notifyDesktop("failproofai", "1 credential", 0, { socketPath: bus.path });
    expect(out).toEqual({ ok: true, id: 77 });
  });

  it("sends the arguments the spec asks for, in order", async () => {
    bus = await startBus(dir, "ok");
    await notifyDesktop("summary here", "body here", 0, { socketPath: bus!.path });
    const raw = bus!.calls[0].toString("latin1");
    expect(raw).toContain("org.freedesktop.Notifications");
    expect(raw).toContain("Notify");
    expect(raw).toContain("susssasa{sv}i");   // the signature the server type-checks against
    expect(raw).toContain("failproofai");     // app_name, which is how the user identifies us
    expect(raw).toContain("summary here");
    expect(raw).toContain("body here");
  });

  it("carries replaces_id so a repeat scan updates one bubble instead of stacking", async () => {
    // The difference between a reminder and a nag: this runs on a timer, and
    // the same finding recurs until the key is rotated.
    bus = await startBus(dir, "ok");
    await notifyDesktop("s", "b", 4242, { socketPath: bus!.path });
    const body = bus!.calls[0];
    expect(body.includes(Buffer.from([0x92, 0x10, 0, 0]))).toBe(true); // 4242, little-endian
  });
});

// THE POINT OF THE WHOLE MODULE. A call sent with NO_REPLY_EXPECTED against a
// bus with no notification server returns success and empty output while the
// notification evaporates — which is the exact failure this feature exists to
// prevent: believing the user was told.
describe("every way this fails, it says so", () => {
  it("names the case where nothing is drawing notifications", async () => {
    bus = await startBus(dir, "no-server");
    const out = await notifyDesktop("s", "b", 0, { socketPath: bus.path });
    expect(out).toMatchObject({ ok: false, reason: "no-server" });
  });

  it("reports a missing socket as no-session rather than as a failure to notify", async () => {
    // Nobody is logged in, so /run/user/<uid> does not exist. Distinguishable
    // from "the desktop refused", because the remedy is different.
    const out = await notifyDesktop("s", "b", 0, { socketPath: join(dir, "absent") });
    expect(out).toMatchObject({ ok: false, reason: "no-session" });
  });

  it("reports a refused handshake as refused", async () => {
    bus = await startBus(dir, "reject-auth");
    const out = await notifyDesktop("s", "b", 0, { socketPath: bus.path });
    expect(out).toMatchObject({ ok: false, reason: "refused" });
  });

  it("gives up on a bus that accepts the connection and then says nothing", async () => {
    // A hung server must not hold the audit open. The timeout is the only
    // branch with no packet to trigger it.
    bus = await startBus(dir, "silent");
    const out = await notifyDesktop("s", "b", 0, { socketPath: bus.path });
    expect(out).toMatchObject({ ok: false, reason: "timeout" });
  }, 10_000);

  it("never throws, whatever the socket does", async () => {
    await expect(notifyDesktop("s", "b", 0, { socketPath: "/" })).resolves.toMatchObject({ ok: false });
  });
});

// ── Against a REAL bus ───────────────────────────────────────────────────────
//
// The tests above drive a server written in this same file, which is exactly
// how the first version of this module shipped a broken encoder: the fake
// mirrored the encoder's own assumptions, so both were wrong together and both
// passed. A real `dbus-daemon` rejected the very first message. These tests
// exist so that cannot happen twice.
//
// Skipped, loudly, when dbus-daemon is not installed — it is a real gap in
// coverage, not a pass.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

function haveDbus(): boolean {
  try {
    execFileSync("dbus-daemon", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const REAL = haveDbus() ? describe : describe.skip;

REAL("the real dbus-daemon", () => {
  // A unix socket path is capped at ~108 bytes, so this cannot live in a long
  // temp dir. Private to this test and torn down after; it is never the user's
  // session bus, and no notification service is registered on it, so nothing
  // can be displayed by anything.
  const dir = `/tmp/fpai-t${process.pid}`;
  const sock = `${dir}/bus`;
  let bus: ChildProcess | null = null;

  beforeEach(async () => {
    mkdirSync(dir, { recursive: true });
    const conf = `${dir}/c.conf`;
    writeFileSync(
      conf,
      `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path=${sock}</listen>
<policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`,
    );
    bus = spawn("dbus-daemon", [`--config-file=${conf}`, "--nofork"], { stdio: "ignore" });
    for (let i = 0; i < 150 && !existsSync(sock); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  afterEach(() => {
    bus?.kill("SIGKILL");
    bus = null;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  // THE REGRESSION. The first encoder declared a header-fields length two bytes
  // too long, because it counted the padding after the final field — padding
  // that belongs to the message, not to the array. Real dbus-daemon hung up;
  // the hand-written server above did not notice. Reaching a NAMED D-Bus error
  // proves the daemon parsed the whole message: auth, Hello, and a Notify whose
  // signature and body it type-checked before deciding nobody serves that name.
  it("accepts our bytes all the way to a semantic error", async () => {
    const out = await notifyDesktop("summary", "body", 0, { socketPath: sock });
    expect(out).toMatchObject({ ok: false, reason: "no-server" });
    expect((out as { detail: string }).detail).toContain("ServiceUnknown");
  });

  it("survives a body no fake server would have stressed", async () => {
    // Multibyte UTF-8 changes byte length independently of character count, and
    // every string in the body is length-prefixed in BYTES.
    for (const [summary, body] of [
      ["клавиша 🔑", "ghp_••••4f2a — naïve"],
      ["", ""],
      ["long", "x".repeat(9000)],
      ["a\nb", "c\r\nd\te"],
    ]) {
      const out = await notifyDesktop(summary, body, 0, { socketPath: sock });
      // Still ServiceUnknown, never a parse failure or a dropped connection.
      expect(out, `${summary.slice(0, 12)}`).toMatchObject({ ok: false, reason: "no-server" });
    }
  });

  it("reports a bus that goes away as something other than a timeout", async () => {
    // A killed bus must not read as "your desktop is slow" — the remedies are
    // completely different, and conflating them is what hid the encoder bug.
    bus?.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    const out = await notifyDesktop("s", "b", 0, { socketPath: sock });
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).not.toBe("timeout");
  });
});

// ── Framing ──────────────────────────────────────────────────────────────────
//
// A real bus does not send one message per TCP chunk. It answers Hello with a
// METHOD_RETURN and then emits a NameAcquired SIGNAL, and those can arrive
// glued together or split anywhere. The first version read "the next chunk" as
// its reply, so a signal landing at the wrong moment was reported as a
// DELIVERED notification with a garbage id.
describe("message framing", () => {
  function signal(): Buffer {
    const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
    const pad8 = (b: Buffer) => { const p = (8 - (b.length % 8)) % 8; return p ? Buffer.concat([b, Buffer.alloc(p)]) : b; };
    const str = (v: string) => { const b = Buffer.from(v); const o = Buffer.concat([u32(b.length), b, Buffer.from([0])]); const p = (4 - (o.length % 4)) % 4; return p ? Buffer.concat([o, Buffer.alloc(p)]) : o; };
    const f = (c: number, t: string, v: Buffer) => pad8(Buffer.concat([Buffer.from([c, 1, t.charCodeAt(0), 0]), v]));
    const fields = Buffer.concat([f(1, "o", str("/org/freedesktop/DBus")), f(3, "s", str("NameAcquired"))]);
    const head = Buffer.concat([Buffer.from([0x6c, 4, 0, 1]), u32(0), u32(77), u32(fields.length)]);
    return pad8(Buffer.concat([head, fields]));
  }

  function bus(dir: string, plan: "signal-first" | "glued" | "byte-at-a-time"): Promise<FakeBus> {
    const path = join(dir, "bus2");
    const calls: Buffer[] = [];
    const server = createServer((s: Socket) => {
      let authed = false;
      let helloDone = false;
      const send = (b: Buffer) => {
        if (plan === "byte-at-a-time") { for (const byte of b) s.write(Buffer.from([byte])); }
        else s.write(b);
      };
      s.on("data", (chunk: Buffer) => {
        if (!authed) { authed = true; s.write("OK 0123456789abcdef0123456789abcdef\r\n"); return; }
        if (!helloDone) {
          helloDone = true;
          // A signal alongside (or before) the Hello reply — what a real bus does.
          if (plan === "signal-first") { send(signal()); send(methodReturn(1, 0)); }
          else send(Buffer.concat([methodReturn(1, 0), signal()]));
          return;
        }
        calls.push(Buffer.from(chunk));
        send(Buffer.concat([signal(), methodReturn(2, 9001)]));
      });
      s.on("error", () => { /* client hangs up after its answer */ });
    });
    return new Promise((res) => server.listen(path, () => res({
      path, server, calls, close: () => new Promise<void>((r) => server.close(() => r())),
    })));
  }

  it("ignores a signal instead of reading it as a delivered notification", async () => {
    bus2 = await bus(dir, "signal-first");
    expect(await notifyDesktop("s", "b", 0, { socketPath: bus2.path })).toEqual({ ok: true, id: 9001 });
  });

  it("splits two messages that arrived in one chunk", async () => {
    bus2 = await bus(dir, "glued");
    expect(await notifyDesktop("s", "b", 0, { socketPath: bus2.path })).toEqual({ ok: true, id: 9001 });
  });

  it("reassembles a reply delivered one byte at a time", async () => {
    // The pathological split. Every partial-read guard has to hold.
    bus2 = await bus(dir, "byte-at-a-time");
    expect(await notifyDesktop("s", "b", 0, { socketPath: bus2.path })).toEqual({ ok: true, id: 9001 });
  }, 10_000);
});
