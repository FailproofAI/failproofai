/**
 * A desktop notification on Linux, from a process with no desktop.
 *
 * The scheduled audit runs as a child of a SYSTEM-scope service. Its
 * environment was measured on a real machine and carries no
 * `DBUS_SESSION_BUS_ADDRESS`, no `DISPLAY`, no `WAYLAND_DISPLAY` and no
 * `XDG_RUNTIME_DIR` — the daemon starts at boot, before anyone logs in, which
 * is the whole reason it survives logout.
 *
 * That turns out not to be a permission problem. `/run/user/<uid>/bus` exists
 * whenever the user is logged in, the daemon already runs as that uid, and
 * D-Bus's EXTERNAL auth is `SO_PEERCRED` — the kernel vouches for the uid, so
 * there is no cookie, no session membership and no environment to inherit. The
 * address just has to be CONSTRUCTED rather than read. Proven on a real bus
 * with a fully scrubbed environment: `AUTH … OK` → accepted.
 *
 * ## Awaiting the reply is the entire correctness story
 *
 * Measured: a call sent with NO_REPLY_EXPECTED against a bus with no
 * notification server returns exit 0, empty stdout, empty stderr — the
 * notification silently evaporates. The same call awaiting its reply returns a
 * named error. Ship the fire-and-forget variant and you get exactly the failure
 * this feature exists to avoid: believing the user was told.
 *
 * With the reply awaited every failure is loud and fast (10-16ms measured):
 * logged out → ENOENT on connect, stale socket → ECONNREFUSED, no desktop →
 * `org.freedesktop.DBus.Error.ServiceUnknown`.
 *
 * One failure is NOT detectable from here and must not be papered over: on a
 * locked screen the shell still owns the name and still returns an id, while
 * the user sees nothing. `Notify` succeeding means the server accepted it,
 * never that a human saw it — which is why the queue, not the toast, is the
 * record of a finding.
 *
 * No dependency: the wire protocol is written by hand rather than pulling a
 * D-Bus client into a package that installs into other people's machines.
 */
import { connect, type Socket } from "node:net";

/** Milliseconds allowed for the whole exchange. Generous — a live bus answers
 *  in ~10ms, and this runs off the hook path entirely. */
const TIMEOUT_MS = 2_000;

export type NotifyOutcome =
  | { ok: true; id: number }
  | { ok: false; reason: "no-session" | "no-server" | "refused" | "timeout" | "error"; detail: string };

/**
 * A D-Bus marshaller that knows where it is.
 *
 * Every alignment rule in the wire format is stated relative to the START OF
 * THE MESSAGE, which is why this tracks an offset instead of padding buffers in
 * isolation. The first version of this file did the latter — each helper padded
 * its own result to the boundary it needed — and it produced a header-fields
 * array two bytes too long, because the padding after the LAST element belongs
 * to the message rather than to the array. Real `dbus-daemon` dropped the
 * connection; the hand-written test server did not, because it mirrored the
 * same assumption the encoder made. The byte diff against a real client's
 * `Hello` is what settled it (0x70 vs 0x6e), and it is why the tests below now
 * run against a real bus.
 */
class Marshal {
  private chunks: Buffer[] = [];
  private len = 0;

  /** Pad to the next `n`-byte boundary, counted from the start of the message. */
  align(n: number): void {
    const pad = (n - (this.len % n)) % n;
    if (pad) this.raw(Buffer.alloc(pad));
  }
  raw(b: Buffer): void {
    this.chunks.push(b);
    this.len += b.length;
  }
  byte(v: number): void {
    this.raw(Buffer.from([v]));
  }
  u32(v: number): void {
    this.align(4);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    this.raw(b);
  }
  i32(v: number): void {
    this.align(4);
    const b = Buffer.alloc(4);
    b.writeInt32LE(v, 0);
    this.raw(b);
  }
  /** STRING / OBJECT_PATH: 4-aligned length, bytes, NUL. */
  str(v: string): void {
    const b = Buffer.from(v, "utf8");
    this.u32(b.length);
    this.raw(b);
    this.byte(0);
  }
  /** SIGNATURE: a single length BYTE, bytes, NUL. No alignment. */
  sig(v: string): void {
    const b = Buffer.from(v, "utf8");
    this.byte(b.length);
    this.raw(b);
    this.byte(0);
  }
  get length(): number {
    return this.len;
  }
  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** One header field: a STRUCT of (BYTE code, VARIANT value), 8-aligned. */
type HeaderField = readonly [code: number, signature: string, value: string];

/**
 * Encode the header-fields array.
 *
 * Returns the declared length SEPARATELY from the bytes, because they are not
 * the same number: the length stops at the end of the last element's content,
 * while the message then pads to 8 before the body. Conflating them is the bug
 * described on `Marshal`.
 */
function headerFields(fields: readonly HeaderField[]): { data: Buffer; declaredLength: number } {
  // The array's data starts at message offset 16, which is already 8-aligned,
  // so offsets inside this marshaller line up with the real message.
  const m = new Marshal();
  for (const [code, signature, value] of fields) {
    m.align(8); // each STRUCT element starts on an 8-byte boundary
    m.byte(code);
    m.sig(signature);
    // Every header field we send is a string-like: OBJECT_PATH, STRING or
    // SIGNATURE. Nothing here needs a numeric variant.
    if (signature === "g") m.sig(value);
    else m.str(value);
  }
  // No trailing padding was added, so the buffer length IS the declared length.
  return { data: m.buffer(), declaredLength: m.length };
}

/** A METHOD_CALL: fixed header, header fields, 8-byte pad, then the body. */
function methodCall(serial: number, fields: readonly HeaderField[], body: Buffer): Buffer {
  const { data, declaredLength } = headerFields(fields);
  const head = new Marshal();
  head.raw(Buffer.from([0x6c, 1, 0, 1])); // little-endian, METHOD_CALL, no flags, proto 1
  head.u32(body.length);
  head.u32(serial);
  head.u32(declaredLength);
  head.raw(data);
  head.align(8); // the body always starts on an 8-byte boundary
  return Buffer.concat([head.buffer(), body]);
}

/**
 * The arguments of `org.freedesktop.Notifications.Notify`.
 *
 * Signature `susssasa{sv}i`: app_name, replaces_id, app_icon, summary, body,
 * actions, hints, expire_timeout.
 */
function notifyBody(app: string, replacesId: number, summary: string, body: string): Buffer {
  const m = new Marshal();
  m.str(app);
  m.u32(replacesId);
  m.str("");        // app_icon — none; the app name is what identifies us
  m.str(summary);
  m.str(body);
  m.u32(0);         // actions: `as`, empty. Element alignment 4, already met.
  m.u32(0);         // hints: `a{sv}`, empty...
  m.align(8);       // ...and an array pads to its ELEMENT alignment even when
                    // empty. DICT_ENTRY is 8, so this padding is required and
                    // counts toward the body length.
  m.i32(-1);        // expire_timeout: -1 lets the server decide
  return m.buffer();
}

/** `org.freedesktop.DBus.Hello` — mandatory before any other method call. */
const HELLO_FIELDS: readonly HeaderField[] = [
  [1, "o", "/org/freedesktop/DBus"],
  [6, "s", "org.freedesktop.DBus"],
  [2, "s", "org.freedesktop.DBus"],
  [3, "s", "Hello"],
];

const NOTIFY_FIELDS: readonly HeaderField[] = [
  [1, "o", "/org/freedesktop/Notifications"],
  [6, "s", "org.freedesktop.Notifications"],
  [2, "s", "org.freedesktop.Notifications"],
  [3, "s", "Notify"],
  [8, "g", "susssasa{sv}i"],
];

/** A parsed inbound message: only what the state machine dispatches on. */
interface Incoming {
  type: number;
  replySerial: number | null;
  errorName: string | null;
  bodyStart: number;
  bodyLength: number;
  total: number;
}

/**
 * Read one whole message out of `buf`, or null when it has not all arrived.
 *
 * A framed reader rather than "assume one message per chunk", because a real
 * bus does not oblige: it answers `Hello` with a METHOD_RETURN and then emits a
 * `NameAcquired` SIGNAL, and the two can land in one chunk or two. The earlier
 * version consumed whichever chunk came first and treated the NEXT one as its
 * reply — which, for a SIGNAL, is neither an error nor a return, so it reported
 * the notification as delivered with a garbage id.
 */
function readMessage(buf: Buffer): Incoming | null {
  if (buf.length < 16) return null;
  const bodyLength = buf.readUInt32LE(4);
  const fieldsLength = buf.readUInt32LE(12);
  const bodyStart = 16 + fieldsLength + ((8 - (fieldsLength % 8)) % 8);
  const total = bodyStart + bodyLength;
  if (buf.length < total) return null;

  let replySerial: number | null = null;
  let errorName: string | null = null;
  // Walk the header fields far enough to find REPLY_SERIAL (5) and ERROR_NAME
  // (4). Anything unparseable stops the walk rather than throwing: a header we
  // cannot read is a message we ignore, not a crash on the audit's exit path.
  let i = 16;
  const end = 16 + fieldsLength;
  while (i < end) {
    i += (8 - ((i - 16) % 8)) % 8; // struct alignment, relative to the array start
    if (i + 4 > end) break;
    const code = buf[i];
    const sigLen = buf[i + 1];
    const sig = buf.toString("latin1", i + 2, i + 2 + sigLen);
    i += 2 + sigLen + 1;
    if (sig === "u") {
      i += (4 - ((i - 16) % 4)) % 4;
      if (i + 4 > end) break;
      if (code === 5) replySerial = buf.readUInt32LE(i);
      i += 4;
    } else if (sig === "s" || sig === "o") {
      i += (4 - ((i - 16) % 4)) % 4;
      if (i + 4 > end) break;
      const len = buf.readUInt32LE(i);
      if (i + 4 + len > end) break;
      if (code === 4) errorName = buf.toString("utf8", i + 4, i + 4 + len);
      i += 4 + len + 1;
    } else if (sig === "g") {
      const len = buf[i];
      i += 1 + len + 1;
    } else {
      break; // a type we do not send and cannot size; stop rather than guess
    }
  }
  return { type: buf[1], replySerial, errorName, bodyStart, bodyLength, total };
}

/**
 * Where this process's session bus lives.
 *
 * Two callers with opposite environments, one rule. A human running
 * `failproofai audit` in their terminal HAS `DBUS_SESSION_BUS_ADDRESS`, and on
 * an unusual setup it is the only correct answer — so it wins when it is there
 * and names a socket we can open. The scheduled audit, a child of a system
 * service started before login, has nothing: for it the address is CONSTRUCTED
 * from the uid, which works because D-Bus EXTERNAL auth is `SO_PEERCRED` and
 * the kernel supplies the identity the environment could not.
 *
 * Only the `unix:path=` form is honored. The spec allows `unix:abstract=`,
 * `tcp:` and semicolon-separated alternatives; a bus we cannot dial is better
 * reported as "no session" than dialed wrong, and the fallback below already
 * covers every desktop that ships systemd.
 */
export function resolveBusPath(env: Readonly<Record<string, string | undefined>>): string | null {
  const declared = env.DBUS_SESSION_BUS_ADDRESS;
  if (declared) {
    for (const part of declared.split(";")) {
      const m = /^unix:(?:.*,)?path=([^,]+)/.exec(part.trim());
      if (m) return m[1];
    }
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  return uid >= 0 ? `/run/user/${uid}/bus` : null;
}

/**
 * Post a notification, awaiting the reply.
 *
 * `replacesId` reuses an earlier notification's id so repeated scans update one
 * bubble instead of stacking a fresh alert every time — the difference between
 * a reminder and a nag.
 */
export function notifyDesktop(
  summary: string,
  body: string,
  replacesId = 0,
  opts: { socketPath?: string } = {},
): Promise<NotifyOutcome> {
  return new Promise((resolvePromise) => {
    if (process.platform !== "linux" && !opts.socketPath) {
      resolvePromise({ ok: false, reason: "error", detail: "linux only" });
      return;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const path = opts.socketPath ?? resolveBusPath(process.env as Record<string, string | undefined>);
    if (!path || uid < 0) {
      resolvePromise({ ok: false, reason: "no-session", detail: "no bus address" });
      return;
    }

    let settled = false;
    const done = (o: NotifyOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already gone */ }
      resolvePromise(o);
    };
    const timer = setTimeout(() => done({ ok: false, reason: "timeout", detail: `${TIMEOUT_MS}ms` }), TIMEOUT_MS);

    let sock: Socket;
    try {
      sock = connect(path);
    } catch (err) {
      done({ ok: false, reason: "no-session", detail: String(err) });
      return;
    }

    let stage: "auth" | "hello" | "notify" = "auth";
    let buf = Buffer.alloc(0);

    sock.on("error", (err: NodeJS.ErrnoException) => {
      // ENOENT: nobody is logged in, so /run/user/<uid> does not exist.
      // ECONNREFUSED: a stale socket left behind by a dead bus.
      done({
        ok: false,
        reason: err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "no-session" : "error",
        detail: err.code ?? String(err),
      });
    });

    // A bus that hangs up mid-exchange is the signature of a message it could
    // not parse. Without this the socket simply goes quiet and the whole thing
    // reports a 2-second timeout — which points at a slow desktop rather than
    // at us, and is exactly how the header-length bug survived its first tests.
    sock.on("close", () => {
      done({ ok: false, reason: "refused", detail: `bus closed the connection during ${stage}` });
    });

    sock.on("connect", () => {
      // SASL EXTERNAL: the kernel already told the bus our uid over SO_PEERCRED,
      // so the "credential" is just that uid in hex and no secret is exchanged.
      const hexUid = Buffer.from(String(uid), "utf8").toString("hex");
      sock.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${hexUid}\r\n`, "utf8")]));
    });

    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === "auth") {
        const text = buf.toString("latin1");
        const nl = text.indexOf("\r\n");
        if (nl === -1) return;
        if (!text.startsWith("OK")) {
          done({ ok: false, reason: "refused", detail: text.slice(0, nl).trim().slice(0, 80) });
          return;
        }
        // Anything after the OK line is already binary protocol — keep it.
        buf = buf.subarray(nl + 2);
        stage = "hello";
        sock.write(Buffer.from("BEGIN\r\n", "utf8"));
        sock.write(methodCall(1, HELLO_FIELDS, Buffer.alloc(0)));
        // Fall through: the reply may already be in `buf`.
      }

      // Consume whole messages only. The bus answers Hello and then emits a
      // NameAcquired SIGNAL; both can arrive in one chunk, and neither is
      // guaranteed to arrive whole.
      for (;;) {
        const msg = readMessage(buf);
        if (!msg) return;
        const frame = buf.subarray(0, msg.total);
        buf = buf.subarray(msg.total);

        // 1 = METHOD_CALL, 2 = METHOD_RETURN, 3 = ERROR, 4 = SIGNAL.
        if (msg.type === 4 || msg.type === 1) continue; // NameAcquired and friends

        if (stage === "hello") {
          if (msg.type === 3) {
            done({ ok: false, reason: "refused", detail: msg.errorName ?? "Hello failed" });
            return;
          }
          if (msg.replySerial !== 1) continue;
          stage = "notify";
          sock.write(methodCall(2, NOTIFY_FIELDS, notifyBody("failproofai", replacesId, summary, body)));
          continue;
        }

        // Only OUR call's reply settles this. Matching on serial rather than on
        // "the next message" is what keeps an unrelated signal from being read
        // as a successful delivery.
        if (msg.replySerial !== 2) continue;

        if (msg.type === 3) {
          const name = msg.errorName ?? "";
          // The common one: logged in, but nothing is drawing notifications.
          const noServer = name.includes("ServiceUnknown") || name.includes("NameHasNoOwner");
          done({ ok: false, reason: noServer ? "no-server" : "error", detail: name || "error" });
          return;
        }

        // METHOD_RETURN. The body is a single UINT32 id — read it back so a
        // future call could replace this bubble rather than stack a new one.
        const id =
          msg.bodyLength >= 4 && frame.length >= msg.bodyStart + 4
            ? frame.readUInt32LE(msg.bodyStart)
            : 0;
        done({ ok: true, id });
        return;
      }
    });
  });
}
