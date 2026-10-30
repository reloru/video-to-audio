#!/usr/bin/env bash
# Builds core/dist/ffmpeg-core.{js,wasm}: the FFmpeg command-line tool compiled
# to WebAssembly with only the components needed to pull audio out of videos.
#
# Everything is pinned so the output is reproducible:
#   - Emscripten SDK, FFmpeg release tag and LAME release (sha256-checked)
#   - fftools sources from ffmpeg.wasm, which patch the ffmpeg CLI so it can be
#     called as a function instead of exiting the process
#   - local FFmpeg patches in core/patches/
#
# Usage: core/build.sh   (work files go to .core-build/, override with CORE_BUILD_DIR)
# Re-running is incremental; changed patches or configure flags trigger a rebuild.
set -euo pipefail

EMSDK_VERSION=3.1.40
FFMPEG_TAG=n5.1.4
LAME_VERSION=3.100
LAME_SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
# ffmpeg.wasm v0.12.10. Its patched fftools target FFmpeg n5.1.x and emsdk 3.1.40.
FFMPEG_WASM_COMMIT=c3a763857c5e615ae8674715ad5e4f63ff469e9d

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${CORE_BUILD_DIR:-$ROOT/.core-build}
PREFIX=$WORK/prefix
OUT=$ROOT/core/dist
JOBS=$(nproc)

mkdir -p "$WORK" "$PREFIX" "$OUT"
cd "$WORK"

# --- Emscripten -------------------------------------------------------------
if [ ! -d emsdk ]; then
  git clone --quiet https://github.com/emscripten-core/emsdk.git
fi
./emsdk/emsdk install "$EMSDK_VERSION" > /dev/null
./emsdk/emsdk activate "$EMSDK_VERSION" > /dev/null
# shellcheck disable=SC1091
source ./emsdk/emsdk_env.sh > /dev/null 2>&1

# --- LAME (MP3 encoder) -----------------------------------------------------
if [ ! -f "$PREFIX/lib/libmp3lame.a" ]; then
  curl -fsSL -o "lame-$LAME_VERSION.tar.gz" \
    "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz"
  echo "$LAME_SHA256  lame-$LAME_VERSION.tar.gz" | sha256sum -c -
  rm -rf "lame-$LAME_VERSION"
  tar xzf "lame-$LAME_VERSION.tar.gz"
  (
    cd "lame-$LAME_VERSION"
    CFLAGS="-O3" emconfigure ./configure \
      --prefix="$PREFIX" \
      --host=i686-linux \
      --disable-shared \
      --disable-frontend \
      --disable-analyzer-hooks \
      --disable-dependency-tracking \
      --disable-gtktest
    emmake make -j"$JOBS" install
  )
fi

# --- FFmpeg libraries -------------------------------------------------------
if [ ! -d ffmpeg ]; then
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$FFMPEG_TAG" \
    https://github.com/FFmpeg/FFmpeg.git ffmpeg
fi

for patch in "$ROOT"/core/patches/*.patch; do
  if ! git -C ffmpeg apply --reverse --check "$patch" 2> /dev/null; then
    git -C ffmpeg apply "$patch"
  fi
done

DEMUXERS=mov,matroska,avi,mpegts,mpegps,flv,ogg,asf,wav,w64,aiff,caf,mp3,aac,ac3,eac3,flac,amr,dts,truehd
DECODERS='aac,aac_latm,alac,mp1,mp1float,mp2,mp2float,mp3,mp3float,ac3,eac3,flac,opus,vorbis,dca,truehd,mlp,wmav1,wmav2,wmapro,amrnb,amrwb,adpcm_ima_qt,adpcm_ima_wav,adpcm_ms,pcm_*'
ENCODERS=libmp3lame,alac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le
MUXERS=ipod,mp4,mp3,wav,null,md5,framemd5,streamhash
PARSERS=aac,aac_latm,ac3,mpegaudio,flac,opus,vorbis,dca,mlp,amr
BSFS=aac_adtstoasc,null
FILTERS=abuffer,abuffersink,aformat,anull,aresample,atrim,apad,pan,volume,buffer,buffersink,format,null,trim

CONFIGURE_FLAGS=(
  --target-os=none --arch=x86_32 --enable-cross-compile
  --disable-asm --disable-stripping --disable-runtime-cpudetect --disable-autodetect
  --disable-programs --disable-doc --disable-debug --disable-network
  --disable-pthreads --disable-w32threads --disable-os2threads
  --disable-everything --disable-avdevice --disable-postproc
  --enable-avcodec --enable-avformat --enable-avfilter --enable-swresample --enable-swscale
  --enable-libmp3lame
  --enable-protocol=file
  --enable-demuxer="$DEMUXERS"
  --enable-decoder="$DECODERS"
  --enable-encoder="$ENCODERS"
  --enable-muxer="$MUXERS"
  --enable-parser="$PARSERS"
  --enable-bsf="$BSFS"
  --enable-filter="$FILTERS"
  --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc
  # Relative to the FFmpeg source directory, where configure and make run. FFmpeg embeds this
  # command line in the binary, so absolute paths would make the output depend on $WORK.
  --extra-cflags="-I../prefix/include -O3"
  --extra-ldflags="-L../prefix/lib"
)
CONFIGURE_HASH=$(printf '%s\n' "${CONFIGURE_FLAGS[@]}" | sha256sum | cut -d' ' -f1)
if [ "$(cat ffmpeg/.configure-hash 2> /dev/null)" != "$CONFIGURE_HASH" ]; then
  (cd ffmpeg && emconfigure ./configure "${CONFIGURE_FLAGS[@]}")
  echo "$CONFIGURE_HASH" > ffmpeg/.configure-hash
fi
emmake make -C ffmpeg -j"$JOBS"

# --- Patched fftools from ffmpeg.wasm ----------------------------------------
if [ ! -d ffmpeg-wasm ]; then
  mkdir ffmpeg-wasm
  (
    cd ffmpeg-wasm
    git init --quiet
    git remote add origin https://github.com/ffmpegwasm/ffmpeg.wasm.git
    git fetch --quiet --depth 1 origin "$FFMPEG_WASM_COMMIT"
    git -c advice.detachedHead=false checkout --quiet FETCH_HEAD
  )
fi

# --- Link -------------------------------------------------------------------
FFTOOLS=$WORK/ffmpeg-wasm/src/fftools
mkdir -p "$WORK/dist"
(
  cd ffmpeg
  # The prefix maps keep absolute build paths (from __FILE__ in assertions) out of the binary,
  # so the output is byte-identical wherever it is built.
  emcc \
    -O3 \
    -fmacro-prefix-map="$WORK/"= -fmacro-prefix-map="$ROOT/"= \
    -I. -I"$FFTOOLS" -I"$PREFIX/include" \
    -Wno-deprecated-declarations \
    "$FFTOOLS/cmdutils.c" \
    "$FFTOOLS/ffmpeg.c" \
    "$FFTOOLS/ffmpeg_filter.c" \
    "$FFTOOLS/ffmpeg_hw.c" \
    "$FFTOOLS/ffmpeg_mux.c" \
    "$FFTOOLS/ffmpeg_opt.c" \
    "$FFTOOLS/opt_common.c" \
    "$ROOT/core/probe.c" \
    -Llibavcodec -Llibavfilter -Llibavformat -Llibavutil -Llibswresample -Llibswscale -L"$PREFIX/lib" \
    -lavfilter -lavformat -lavcodec -lswresample -lswscale -lavutil -lmp3lame \
    -sWASM_BIGINT \
    -sMODULARIZE \
    -sEXPORT_ES6 \
    -sEXPORT_NAME=createFFmpegCore \
    -sENVIRONMENT=web,worker,node \
    -sINITIAL_MEMORY=32MB \
    -sALLOW_MEMORY_GROWTH \
    -sSTACK_SIZE=5MB \
    -sEXPORTED_FUNCTIONS=_ffmpeg,_probe,_abort,_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=FS,setValue,getValue,UTF8ToString,lengthBytesUTF8,stringToUTF8 \
    -lworkerfs.js \
    --pre-js "$ROOT/core/bind.js" \
    -o "$WORK/dist/ffmpeg-core.js"
)

cp "$WORK/dist/ffmpeg-core.js" "$WORK/dist/ffmpeg-core.wasm" "$OUT/"
{
  echo "Built by core/build.sh"
  echo "emsdk $EMSDK_VERSION"
  echo "FFmpeg $FFMPEG_TAG ($(git -C ffmpeg rev-parse HEAD)) + core/patches"
  echo "LAME $LAME_VERSION (sha256 $LAME_SHA256)"
  echo "ffmpeg.wasm fftools $FFMPEG_WASM_COMMIT"
  echo
  (cd "$OUT" && sha256sum ffmpeg-core.js ffmpeg-core.wasm)
} > "$OUT/BUILD-INFO.txt"
cat "$OUT/BUILD-INFO.txt"
