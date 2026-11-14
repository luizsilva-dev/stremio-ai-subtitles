# Changelog

## [2.2.0](https://github.com/luizsilva-dev/stremio-ai-subtitles/compare/v2.1.1...v2.2.0) (2026-11-14)


### Features

* option to offer AI subtitles only when none exist in the chosen language ([2745fd2](https://github.com/luizsilva-dev/stremio-ai-subtitles/commit/2745fd2b5ee6d79f45b747cfd16d702e10ea8c00))
* pick the model from a dropdown after loading the list ([93f17c0](https://github.com/luizsilva-dev/stremio-ai-subtitles/commit/93f17c00cc0fb40ae70f62b4ce1bc5f2e8ab152a))


### Bug Fixes

* don't pre-translate when OpenSubtitles already has the chosen language ([7252bac](https://github.com/luizsilva-dev/stremio-ai-subtitles/commit/7252bac4d75e77395f6de44f16103a54d9ef4e84))
* keep subtitle positions and styling out of the AI translation ([4523827](https://github.com/luizsilva-dev/stremio-ai-subtitles/commit/4523827d7e2e6b22dd12b1c2dd9da9f66d674b9a))
* keep tags in the middle of a line, letting the AI place them ([6ee5261](https://github.com/luizsilva-dev/stremio-ai-subtitles/commit/6ee52616720045d0d30d2d2147277c523ec28c2e))

## [2.1.1](https://github.com/luizsilva-dev/stremio-ai-subtitles/compare/v2.1.0...v2.1.1) (2026-10-18)


### Bug Fixes

* keep refused requests out of the rate limiter and count re-stored subtitles once ([d904523](https://github.com/luizsilva-dev/stremio-ai-subtitles/commit/d904523426d27157ce125dc0886c763c412bd60b)), closes [#2](https://github.com/luizsilva-dev/stremio-ai-subtitles/issues/2)
