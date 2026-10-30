// Hand-written declaration for the Emscripten glue emitted by core/build.sh.
import type { CoreFactory } from "../../src/engine/core";

declare const createFFmpegCore: CoreFactory;
export default createFFmpegCore;
