// Prepended to the Emscripten glue (--pre-js). Adapted from ffmpeg.wasm's
// src/bind/ffmpeg/bind.js (MIT). The patched fftools call Module.receiveProgress
// and read Module.timeout / write Module.ret; probe.c calls Module.receiveProbe.

const DEFAULT_ARGS = ["./ffmpeg", "-nostdin", "-y"];

Module["ret"] = -1;
Module["timeout"] = -1;
Module["logger"] = () => {};
Module["progress"] = () => {};
Module["probeResult"] = null;

function stringToPtr(str) {
  const len = Module["lengthBytesUTF8"](str) + 1;
  const ptr = Module["_malloc"](len);
  Module["stringToUTF8"](str, ptr, len);
  return ptr;
}

function stringsToPtr(strs) {
  const ptr = Module["_malloc"](strs.length * 4);
  for (let i = 0; i < strs.length; i++) {
    Module["setValue"](ptr + 4 * i, stringToPtr(strs[i]), "i32");
  }
  return ptr;
}

Module["print"] = (message) => Module["logger"]({ type: "stdout", message });
Module["printErr"] = (message) => {
  if (!message.startsWith("Aborted(native code called abort())")) {
    Module["logger"]({ type: "stderr", message });
  }
};

// Runs the ffmpeg CLI. The patched fftools end every run with abort(), so the
// module instance must not be reused for another exec afterwards.
Module["exec"] = (...args) => {
  const argv = [...DEFAULT_ARGS, ...args];
  try {
    Module["_ffmpeg"](argv.length, stringsToPtr(argv));
  } catch (e) {
    if (!(e && typeof e.message === "string" && e.message.startsWith("Aborted"))) {
      throw e;
    }
  }
  return Module["ret"];
};

Module["probe"] = (path) => {
  Module["probeResult"] = null;
  const ptr = stringToPtr(path);
  try {
    Module["_probe"](ptr);
  } finally {
    Module["_free"](ptr);
  }
  return JSON.parse(Module["probeResult"]);
};

Module["receiveProbe"] = (json) => {
  Module["probeResult"] = json;
};

Module["receiveProgress"] = (progress, time) => {
  Module["progress"]({ progress, time });
};
