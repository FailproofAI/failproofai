import { askWeather } from "./actions";

export const dynamic = "force-dynamic";

export default function Page() {
  async function submit(): Promise<void> {
    "use server";
    await askWeather();
  }
  return (
    <form action={submit}>
      <button type="submit">Ask</button>
    </form>
  );
}
