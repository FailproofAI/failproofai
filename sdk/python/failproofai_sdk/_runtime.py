"""The process-wide writer and event namespace.

These used to be constructed in `failproofai_sdk/__init__.py`. They live in a
leaf module now so that `_scopes` and the framework adapters can reach the
namespace without importing the `failproofai_sdk` package itself, which would be
a circular import.

Constructing `EventWriter` starts a daemon thread and registers the module-level
atexit flush, and that still happens at `import failproofai_sdk` time —
`__init__.py` imports this module, so the timing is unchanged.

Reach the namespace as `_runtime.event`, an attribute lookup at call time rather
than a `from ... import event` binding, so a test can swap in a recording
namespace and the scopes pick it up.
"""

from failproofai_sdk._events import EventNamespace
from failproofai_sdk._writer import EventWriter

writer = EventWriter()
event = EventNamespace(writer)
