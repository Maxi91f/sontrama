"""Compare an isolated SSH target's native DSP with the production WASM adapter.

Usage: uv run --frozen python scripts/check-arm-parity.py HOST PYTHON /tmp/sontrama-parity-NAME
The target needs a C compiler and the locked application runtime dependencies.
No service, application files, settings or audio devices are changed.
"""

import argparse
import ast
import base64
import importlib.util
import json
import re
import shlex
import subprocess
import tarfile
import tempfile
from pathlib import Path

import numpy as np


def run(arguments):
    return subprocess.run(arguments, check=True, capture_output=True, text=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host")
    parser.add_argument("python")
    parser.add_argument("directory")
    args = parser.parse_args()
    if args.host.startswith("-") or not re.fullmatch(
        r"/tmp/sontrama-parity-[A-Za-z0-9_-]+", args.directory
    ):
        parser.error("Use an SSH host and an isolated /tmp/sontrama-parity-* directory")
    root = Path(__file__).resolve().parents[1]
    source = root / "tests/test_shared_dsp.py"
    spec = importlib.util.spec_from_file_location("shared_dsp_cases", source)
    cases_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cases_module)
    cases = [
        cases_module.make_case(scenario, rate)
        for scenario in cases_module.SCENARIOS
        for rate in (44100, 48000)
    ]
    tree = ast.parse(source.read_text())
    nodes = [
        node
        for node in tree.body
        if isinstance(node, (ast.Import, ast.ImportFrom))
        and not (
            isinstance(node, ast.Import) and any(alias.name == "pytest" for alias in node.names)
        )
    ]
    nodes.extend(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "render_native"
    )
    driver = (
        ast.unparse(ast.Module(body=nodes, type_ignores=[]))
        + """
import sys
from pathlib import Path
cases=json.loads(Path(sys.argv[1]).read_text())
result={}
for case in cases:
    for bus,samples in render_native(case).items():
        result[case['name']+'::'+bus]=samples
np.savez_compressed(sys.argv[2],**result)
"""
    )
    quote = shlex.quote
    remote = args.directory
    with tempfile.TemporaryDirectory(prefix="sontrama-arm-check-") as temporary:
        directory = Path(temporary)
        (directory / "render.py").write_text(driver)
        (directory / "cases.json").write_text(json.dumps(cases))
        archive = directory / "input.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            for path in (root / "src/sontrama").rglob("*"):
                if path.is_file() and "__pycache__" not in path.parts:
                    bundle.add(path, arcname=str(path.relative_to(root)))
            bundle.add(directory / "render.py", arcname="render.py")
            bundle.add(directory / "cases.json", arcname="cases.json")
        run(["ssh", args.host, "mkdir -- " + quote(remote)])
        try:
            run(["scp", "-q", str(archive), args.host + ":" + remote + "/input.tar.gz"])
            run(
                [
                    "ssh",
                    args.host,
                    "tar -xzf " + quote(remote + "/input.tar.gz") + " -C " + quote(remote),
                ]
            )
            command = f"PYTHONPATH={quote(remote + '/src')} SONTRAMA_NATIVE_CACHE={quote(remote + '/cache')} OPENBLAS_NUM_THREADS=1 {quote(args.python)} {quote(remote + '/render.py')} {quote(remote + '/cases.json')} {quote(remote + '/native.npz')}"
            run(["ssh", args.host, command])
            run(
                [
                    "scp",
                    "-q",
                    args.host + ":" + remote + "/native.npz",
                    str(directory / "native.npz"),
                ]
            )
            run(["node", str(root / "scripts/build-dsp.mjs")])
            result = subprocess.run(
                ["node", str(root / "scripts/render-core.mjs")],
                input=json.dumps(cases),
                text=True,
                capture_output=True,
                check=True,
                timeout=120,
            )
            native = np.load(directory / "native.npz")
            maximum = 0
            for case in json.loads(result.stdout):
                for bus in ("samples", "channel", "master"):
                    actual = np.frombuffer(base64.b64decode(case[bus]), dtype="<f4").reshape(-1, 2)
                    expected = native[case["name"] + "::" + bus]
                    error = float(np.max(np.abs(actual - expected)))
                    maximum = max(maximum, error)
                    if not np.allclose(actual, expected, atol=2e-5, rtol=2e-5):
                        raise AssertionError((case["name"], bus, error))
            print(
                f"{len(cases)} native/WASM cases passed on the SSH target; maximum sample error {maximum:.9g}"
            )
        finally:
            run(["ssh", args.host, "rm -rf -- " + quote(remote)])


if __name__ == "__main__":
    main()
