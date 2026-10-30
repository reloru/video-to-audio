/*
 * probe(path): describes a media file's container and streams as JSON and hands
 * the string to Module.receiveProbe. Used instead of parsing `ffmpeg -i` logs.
 */
#include <emscripten.h>

#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/bprint.h"
#include "libavutil/channel_layout.h"
#include "libavutil/pixdesc.h"

EM_JS(void, send_probe, (const char *json), {
    Module.receiveProbe(UTF8ToString(json));
});

static void put_str(AVBPrint *b, const char *s)
{
    av_bprint_chars(b, '"', 1);
    for (; s && *s; s++) {
        unsigned char c = *s;
        if (c == '"' || c == '\\')
            av_bprintf(b, "\\%c", c);
        else if (c < 0x20)
            av_bprintf(b, "\\u%04x", c);
        else
            av_bprint_chars(b, c, 1);
    }
    av_bprint_chars(b, '"', 1);
}

static void put_key_str(AVBPrint *b, const char *key, const char *val)
{
    av_bprintf(b, ",\"%s\":", key);
    if (val)
        put_str(b, val);
    else
        av_bprintf(b, "null");
}

static void put_seconds(AVBPrint *b, const char *key, int64_t ts, AVRational tb)
{
    if (ts == AV_NOPTS_VALUE)
        av_bprintf(b, ",\"%s\":null", key);
    else
        av_bprintf(b, ",\"%s\":%.6f", key, ts * av_q2d(tb));
}

static void put_stream(AVBPrint *b, const AVStream *st)
{
    const AVCodecParameters *par = st->codecpar;
    const AVDictionaryEntry *lang = av_dict_get(st->metadata, "language", NULL, 0);
    char tag[AV_FOURCC_MAX_STRING_SIZE] = { 0 };

    av_bprintf(b, "{\"index\":%d", st->index);
    put_key_str(b, "type", av_get_media_type_string(par->codec_type));
    put_key_str(b, "codec", par->codec_id == AV_CODEC_ID_NONE ? NULL : avcodec_get_name(par->codec_id));
    if (par->codec_tag)
        av_fourcc_make_string(tag, par->codec_tag);
    put_key_str(b, "codecTag", par->codec_tag ? tag : NULL);
    put_key_str(b, "profile", avcodec_profile_name(par->codec_id, par->profile));
    av_bprintf(b, ",\"decodable\":%s", avcodec_find_decoder(par->codec_id) ? "true" : "false");
    av_bprintf(b, ",\"bitRate\":%" PRId64, par->bit_rate);
    put_seconds(b, "duration", st->duration, st->time_base);
    av_bprintf(b, ",\"default\":%s", (st->disposition & AV_DISPOSITION_DEFAULT) ? "true" : "false");
    put_key_str(b, "language", lang ? lang->value : NULL);

    if (par->codec_type == AVMEDIA_TYPE_AUDIO) {
        char layout[128] = { 0 };
        if (av_channel_layout_describe(&par->ch_layout, layout, sizeof(layout)) < 0)
            layout[0] = 0;
        av_bprintf(b, ",\"sampleRate\":%d,\"channels\":%d", par->sample_rate, par->ch_layout.nb_channels);
        put_key_str(b, "channelLayout", layout[0] ? layout : NULL);
        put_key_str(b, "sampleFormat", av_get_sample_fmt_name(par->format));
        av_bprintf(b, ",\"bitsPerRawSample\":%d,\"bitsPerCodedSample\":%d",
                   par->bits_per_raw_sample, par->bits_per_coded_sample);
        av_bprintf(b, ",\"initialPadding\":%d,\"frameSize\":%d", par->initial_padding, par->frame_size);
        if (st->duration != AV_NOPTS_VALUE && par->sample_rate > 0)
            av_bprintf(b, ",\"durationSamples\":%" PRId64,
                       av_rescale_q(st->duration, st->time_base, (AVRational){ 1, par->sample_rate }));
        else
            av_bprintf(b, ",\"durationSamples\":null");
    } else if (par->codec_type == AVMEDIA_TYPE_VIDEO) {
        av_bprintf(b, ",\"width\":%d,\"height\":%d", par->width, par->height);
        put_key_str(b, "colorTransfer", par->color_trc == AVCOL_TRC_UNSPECIFIED ? NULL : av_color_transfer_name(par->color_trc));
        put_key_str(b, "colorPrimaries", par->color_primaries == AVCOL_PRI_UNSPECIFIED ? NULL : av_color_primaries_name(par->color_primaries));
    }
    av_bprintf(b, "}");
}

EMSCRIPTEN_KEEPALIVE
int probe(const char *path)
{
    AVFormatContext *fmt = NULL;
    AVBPrint b;
    int ret;

    av_bprint_init(&b, 0, AV_BPRINT_SIZE_UNLIMITED);

    ret = avformat_open_input(&fmt, path, NULL, NULL);
    if (ret >= 0)
        ret = avformat_find_stream_info(fmt, NULL);

    if (ret < 0) {
        char err[AV_ERROR_MAX_STRING_SIZE] = { 0 };
        av_strerror(ret, err, sizeof(err));
        av_bprintf(&b, "{\"error\":");
        put_str(&b, err);
        av_bprintf(&b, "}");
    } else {
        av_bprintf(&b, "{\"format\":");
        put_str(&b, fmt->iformat->name);
        put_seconds(&b, "duration", fmt->duration, AV_TIME_BASE_Q);
        put_seconds(&b, "startTime", fmt->start_time, AV_TIME_BASE_Q);
        av_bprintf(&b, ",\"bitRate\":%" PRId64 ",\"streams\":[", fmt->bit_rate);
        for (unsigned i = 0; i < fmt->nb_streams; i++) {
            if (i)
                av_bprint_chars(&b, ',', 1);
            put_stream(&b, fmt->streams[i]);
        }
        av_bprintf(&b, "]}");
    }

    avformat_close_input(&fmt);

    if (!av_bprint_is_complete(&b)) {
        av_bprint_finalize(&b, NULL);
        send_probe("{\"error\":\"out of memory\"}");
        return AVERROR(ENOMEM);
    }
    send_probe(b.str);
    av_bprint_finalize(&b, NULL);
    return ret < 0 ? ret : 0;
}
