"""Run an evaluator declared as ``module:attribute``."""

from __future__ import annotations

import argparse
import importlib
import os
from collections.abc import Sequence

from failproofai_sdk.evaluator.authoring import Evaluator


def load_evaluator(spec: str) -> Evaluator:
    module_name, separator, attribute = spec.partition(":")
    if not module_name:
        raise ValueError("evaluator module must not be empty")
    if not separator:
        attribute = "app"
    if not attribute:
        raise ValueError("evaluator attribute must not be empty")
    module = importlib.import_module(module_name)
    try:
        evaluator = getattr(module, attribute)
    except AttributeError as error:
        raise ValueError(f"{spec!r} does not define {attribute!r}") from error
    if not isinstance(evaluator, Evaluator):
        raise TypeError(
            f"{spec!r} resolved to {type(evaluator).__name__}, not Evaluator"
        )
    return evaluator


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m failproofai_sdk.evaluator")
    parser.add_argument(
        "module",
        nargs="?",
        default=os.environ.get("FAILPROOFAI_EVALUATOR_MODULE"),
        help="Python module and optional attribute (for example my_evals:app)",
    )
    args = parser.parse_args(argv)
    if not args.module:
        parser.error("module is required (or set FAILPROOFAI_EVALUATOR_MODULE)")
    load_evaluator(args.module).run_from_env()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
