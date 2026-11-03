# _shared

Cosmetics for the runnable examples. **Nothing here is part of the SDK**, and no
example needs it to instrument correctly.

Two helpers:

- `model()` — reads `FPAI_MODEL` / `MODEL`, defaults to `gpt-4o-mini`, so one
  export drives every example.
- `trace(session_id)` — prints the event stream the run produced.

`trace()` is why the examples are worth running rather than reading. An adapter
that "works" is one whose event stream you can see, so every example ends by
printing its own instead of asserting in a comment that events happened.

## why it taps the writer instead of reading the spool

When `failproofaid` is running it collects and **deletes** each batch file
within milliseconds of it appearing. A spool read therefore races the collector
and returns only whatever has not shipped yet — which looks exactly like an
adapter that emitted nothing but its closing events.

That is not hypothetical: it is what happened the first time these examples were
run, and it read as three adapter bugs that did not exist.

So `capture()` wraps `failproofai_sdk._writer.submit` and appends every entry to
a list first. Same dict that goes to disk, race-free, and it works whether or not
a daemon is running. `banner()` calls it, so every example is tapped from its
first line.

## removing it

Each example starts with two bootstrap lines that exist only to import this
package:

```python
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
...
from _shared import banner, model, trace
```

Delete those and the `banner()` / `trace()` calls, and the example still
instruments correctly. It just stops printing.
