#!/usr/bin/env bash
# Regenerates the test fixtures with a native ffmpeg that has libx264, libx265 and libopus.
# The clips are tiny but mirror the layouts seen in real iPhone screen recordings and
# downloaded videos: HEVC + AAC in QuickTime with moov at the end, HEVC HDR10 in mp42
# with the audio as track 1, H.264 with faststart, video-only files, odd sample rates.
set -euo pipefail
cd "$(dirname "$0")"

FF=(ffmpeg -hide_banner -loglevel error -y)
STEREO="aevalsrc=0.5*sin(2*PI*440*t)+0.1*sin(2*PI*5000*t)|0.5*sin(2*PI*660*t)+0.1*sin(2*PI*9000*t)"
VID="testsrc2=size=64x128:rate=10"

# iPhone-style screen recording: HEVC (hvc1) + AAC-LC 44.1 kHz stereo, QuickTime brand,
# mdat before moov, plus container metadata that must not reach the output.
"${FF[@]}" -f lavfi -i "$VID:duration=2" -f lavfi -i "$STEREO:s=44100:d=2" \
  -c:v libx265 -x265-params log-level=error -tag:v hvc1 -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -metadata title="Secret title" -metadata creation_time=2026-10-30T09:06:23Z \
  -metadata location="+29.9500-095.0600/" -metadata:s:a handler_name="Core Media Audio" \
  -f mov hevc-aac.mov

# HEVC Main10 tagged HDR10 (BT.2020 + PQ), mp42 brand, audio stored as track 1.
"${FF[@]}" -f lavfi -i "$VID:duration=2" -f lavfi -i "$STEREO:s=44100:d=2" \
  -map 1:a -map 0:v \
  -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p10le \
  -x265-params "log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400" \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc \
  -c:a aac -b:a 128k -brand mp42 -metadata author="Someone" \
  hevc-hdr10-aac.mp4

# H.264 + AAC with moov first (faststart), M4V brand.
"${FF[@]}" -f lavfi -i "$VID:duration=2" -f lavfi -i "$STEREO:s=44100:d=2" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 160k -brand M4V -movflags +faststart \
  h264-aac.m4v

# Video only (no audio track), with the usual Lavf encoder tag.
"${FF[@]}" -f lavfi -i "$VID:duration=1" -c:v libx264 -pix_fmt yuv420p h264-noaudio.mp4

# HEVC video only, QuickTime.
"${FF[@]}" -f lavfi -i "$VID:duration=1" -c:v libx265 -x265-params log-level=error -tag:v hvc1 \
  -pix_fmt yuv420p -f mov hevc-noaudio.mov

# AAC at 8 kHz mono, like some web downloads.
"${FF[@]}" -f lavfi -i "$VID:duration=2" -f lavfi -i "sine=frequency=700:sample_rate=8000:duration=2" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 24k h264-aac-8k-mono.mp4

# 5.1 AAC at 48 kHz.
"${FF[@]}" -f lavfi -i "$VID:duration=2" \
  -f lavfi -i "aevalsrc=0.3*sin(2*PI*220*t)|0.3*sin(2*PI*330*t)|0.3*sin(2*PI*440*t)|0.1*sin(2*PI*55*t)|0.3*sin(2*PI*550*t)|0.3*sin(2*PI*660*t):s=48000:d=2:c=5.1" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 384k h264-aac-51.mp4

# Uncompressed 24-bit PCM in QuickTime, 48 kHz stereo, plus a timecode data track.
"${FF[@]}" -f lavfi -i "$VID:duration=2" -f lavfi -i "$STEREO:s=48000:d=2" \
  -c:v libx264 -pix_fmt yuv420p -c:a pcm_s24le -timecode 01:00:00:00 -f mov h264-pcm24.mov

# 16-bit big-endian PCM ("twos") in QuickTime, 44.1 kHz stereo.
"${FF[@]}" -f lavfi -i "$VID:duration=2" -f lavfi -i "$STEREO:s=44100:d=2" \
  -c:v libx264 -pix_fmt yuv420p -c:a pcm_s16be -f mov h264-pcm16be.mov

# Opus in Matroska (lossy, but not AAC).
"${FF[@]}" -f lavfi -i "$VID:duration=2" -f lavfi -i "$STEREO:s=48000:d=2" \
  -c:v libx264 -pix_fmt yuv420p -c:a libopus -b:a 128k h264-opus.mkv

# ADTS AAC in MPEG-TS: copying into M4A needs the aac_adtstoasc bitstream filter.
"${FF[@]}" -f lavfi -i "$VID:duration=2" -f lavfi -i "$STEREO:s=48000:d=2" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k -f mpegts h264-aac.ts

# Two audio tracks: the second one is flagged default.
"${FF[@]}" -f lavfi -i "$VID:duration=2" -f lavfi -i "sine=frequency=300:sample_rate=44100:duration=2" \
  -f lavfi -i "$STEREO:s=48000:d=2" \
  -map 0:v -map 1:a -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k \
  -metadata:s:a:0 language=spa -metadata:s:a:1 language=eng \
  -disposition:a:0 0 -disposition:a:1 default \
  h264-two-audio.mp4

ls -l
