"""Per-framework adapter tests.

A package (not a bare directory) because `tests/` is one: without an
`__init__.py` two files called `test_<framework>.py` in different directories
would collide on the module name under rootdir-based collection.
"""
