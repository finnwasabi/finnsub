# Subtitle Translate

A Stremio addon that fetches English subtitles from OpenSubtitles and translates them into the
language you pick, using Google Translate or any OpenAI compatible model. Timing, line breaks and
formatting are preserved, and every translation is cached so the next play is instant.

This is a fork of [HimAndRobot/stremio-translate-subtitle-by-geanpn](https://github.com/HimAndRobot/stremio-translate-subtitle-by-geanpn)
by Gean Pedro da Silva, built on the upstream `old` branch: SQLite, an in-memory queue, one
container, no Redis or MySQL.

## What this fork changes

**A failed translation is no longer permanent.** Upstream wrote the database row when a job was
queued rather than when it finished, so any failure left a row pointing at the "please wait"
placeholder and every later request served that placeholder back forever. Rows are now written
after the file is on disk, and a row is trusted only when the file behind it really exists.

**A bad batch no longer costs the whole episode.** Failing batches are split in half and retried
down to a single line; whatever still fails is kept in the original language so timings stay
aligned. Model output is parsed leniently, which recovers the code fences, stray prose, trailing
commas and raw line breaks that small models produce.

**Quota errors are understood.** They are not retried, since a daily allowance does not come back
in three seconds, and `model_name` accepts a comma separated list so a run moves to the next model
when one is spent. Spent models are remembered for an hour.

**Keys stay out of the logs.** Stremio carries addon configuration in the request path, so the
provider key was printed on every request. It is now masked everywhere, and operators should
filter their reverse proxy access logs too.

**Subtitle files are parsed by block.** The old line-by-line state machine could drop or duplicate
one line depending on whether the file ended with a blank line, which silently shifted every later
subtitle onto the wrong timestamp.

**The configure page was rebuilt**: light and dark, a link to each provider's key page, and a
button that asks your provider which models your key can actually reach, because a hard-coded list
goes stale every few months.

Smaller things: a real addon logo served over an absolute URL, ISO 639-2 language codes so clients
name the track instead of calling it unknown, batch size and pauses moved to environment
variables, temporary download directories cleaned up, and `npm ci` in the Dockerfile.

## Running it

```bash
git clone https://github.com/finnwasabi/finnsub.git
cd finnsub
cp .env.example .env      # set BASE_URL to the public address of the addon
docker compose up -d
```

Then open `/configure`, choose a provider, paste a key and install. Nothing is stored server side
except the translated subtitles: the configuration, including the key, lives in the addon URL,
so give each person their own key rather than sharing a link.

### Settings worth knowing

| Variable | Default | What it does |
|---|---|---|
| `BASE_URL` | none | public address, used in subtitle and logo URLs |
| `TRANSLATE_BATCH_SIZE` | 200 | subtitle lines per request, 50 for ChatGPT API |
| `TRANSLATE_BATCH_PAUSE_MS` | 4000 | pause between batches |
| `TRANSLATE_MAX_RETRIES` | 3 | retries for failures that are not quota related |
| `QUOTA_MEMORY_MS` | 3600000 | how long a spent model is skipped |
| `DEBUG_TRANSLATE` | false | write mismatched batches to `debug/` |

## Credit

All of the original work is Gean Pedro da Silva's. Upstream is still developed on `main`, which
runs a heavier stack with MySQL and Redis and has features this branch does not, including a
translation dashboard. If you want that, go there. MIT licensed, same as upstream.
