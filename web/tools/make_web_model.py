"""Build web/model/nmp_web.tflite from basic_pitch/saved_models/icassp_2022/nmp.tflite for LiteRT.js.

Two metadata-only edits; weights and operators are untouched:
  1. Fix the dynamic batch dimension to 1 (every shape_signature -1 becomes 1).
  2. Make the graph outputs the three LOGISTIC tensors, skipping the final RESHAPEs.
     Values are identical; each output shape gains a trailing 1.

Needs TensorFlow (`pip install 'basic-pitch[tf]'`). Run from the repo root:
    python web/tools/make_web_model.py
"""

import pathlib

import numpy as np
import tensorflow as tf
from tensorflow.lite.tools import flatbuffer_utils

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "basic_pitch/saved_models/icassp_2022/nmp.tflite"
DST = ROOT / "web/model/nmp_web.tflite"


def make_web_model(src: pathlib.Path, dst: pathlib.Path) -> None:
    model = flatbuffer_utils.read_model(str(src))
    subgraph = model.subgraphs[0]
    for tensor in subgraph.tensors:
        if tensor.shapeSignature is not None:
            tensor.shapeSignature = [1 if d == -1 else int(d) for d in tensor.shapeSignature]

    # Map each signature output back through its RESHAPEs to the LOGISTIC that produces it.
    interpreter = tf.lite.Interpreter(str(src))
    interpreter.allocate_tensors()
    producer = {op["outputs"][0]: op for op in interpreter._get_ops_details()}
    outputs = []
    for signature_output in model.signatureDefs[0].outputs:
        index = signature_output.tensorIndex
        op = producer[index]
        while op["op_name"] == "RESHAPE":
            index = op["inputs"][0]
            op = producer[index]
        assert op["op_name"] == "LOGISTIC", op["op_name"]
        signature_output.tensorIndex = index
        outputs.append(index)
    subgraph.outputs = outputs
    flatbuffer_utils.write_model(model, str(dst))


def check_same_outputs(src: pathlib.Path, dst: pathlib.Path) -> None:
    x = np.random.default_rng(0).uniform(-0.5, 0.5, (1, 43844, 1)).astype(np.float32)
    runs = []
    for path in (src, dst):
        interpreter = tf.lite.Interpreter(str(path))
        interpreter.allocate_tensors()
        runs.append(interpreter.get_signature_runner()(input_2=x))
    original, web = runs
    for name, value in original.items():
        assert np.array_equal(value, web[name].reshape(value.shape)), name


if __name__ == "__main__":
    make_web_model(SRC, DST)
    check_same_outputs(SRC, DST)
    print(f"wrote {DST.relative_to(ROOT)}: same outputs as {SRC.relative_to(ROOT)}")
