(() => {
  "use strict";

  const library = window.KOKKY;
  if (!library) return;

  const FILE_MODE = window.location.protocol === "file:";

  const SC_CONFIG = {
    api: "https://api-v2.soundcloud.com",
    clientId:
      (library.soundcloud && library.soundcloud.clientId) ||
      "qLcgHhXgeEFFaSolTB9I71LBsqncsD93",
    proxy: (library.soundcloud && library.soundcloud.proxy) || "",
    proxies:
      library.soundcloud && Array.isArray(library.soundcloud.proxies)
        ? library.soundcloud.proxies
        : [],
    mediaProxy:
      (library.soundcloud && library.soundcloud.mediaProxy) ||
      "https://proxy.corsfix.com/?url=",
  };

  const FEED_QUERIES =
    Array.isArray(library.feedQueries) && library.feedQueries.length
      ? library.feedQueries
      : ["pop hits", "hip hop", "r&b", "electronic", "indie", "chill"];

  // Курируемый список артистов СНГ из library.js.
  const ARTISTS = Array.isArray(library.artists)
    ? library.artists.filter((artist) => artist && artist.name)
    : [];

  const STORE = {
    liked: "kokky:liked:sc",
    volume: "kokky:volume",
    motion: "kokky:motion",
    playlists: "kokky:playlists:sc",
    feed: "kokky:feed:sc",
    artist: "kokky:artist:sc",
    taste: "kokky:taste:sc",
  };

  const FALLBACK_COVER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480"><rect width="480" height="480" fill="#0d0d0d"/><path d="M240 152 336 328H144Z" fill="#262626"/></svg>'
  )}`;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  let feed = [];
  let feedError = false;

  /* =========================================================
     Track helpers
     ========================================================= */

  const ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };

  const decodeEntities = (value) =>
    String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, code) => {
      const key = String(code).toLowerCase();
      if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
      return ENTITIES[key] || match;
    });

  const cleanArtist = (name) =>
    decodeEntities(name || "неизвестный артист")
      .replace(/\s+/g, " ")
      .trim() || "неизвестный артист";

  // Обложки каталога бывают 100px и 500px — просим большую.
  const coverFor = (url) => {
    const source = String(url || "");
    if (!source) return FALLBACK_COVER;
    return source
      .replace("-large.", "-t500x500.")
      .replace("-crop.", "-t500x500.")
      .replace("/large/", "/t500x500/");
  };

  // SNIP — это 30-секундный отрывок, такие треки не берём.
  const isStreamable = (item) =>
    !!item &&
    item.kind === "track" &&
    item.streamable !== false &&
    item.policy !== "SNIP" &&
    item.policy !== "BLOCK" &&
    item.access !== "blocked";

  const isTalky = (title) =>
    /\b(podcast|podcast episode|episode|interview|audiobook|dj set|live set)\b/i.test(
      String(title || "")
    );

  const fromSoundCloud = (item) => {
    if (!isStreamable(item)) return null;

    // Превью на 30 секунд в каталог не берём: нужен только полный трек.
    const access = String(item.policy || "ALLOW").toUpperCase();
    if (access === "SNIP" || access === "BLOCK") return null;

    const id = item.id == null ? "" : String(item.id);
    if (!/^\d+$/.test(id)) return null;

    const title = decodeEntities(item.title || "без названия").trim() || "без названия";
    if (isTalky(title)) return null;

    const duration = Math.max(0, Math.round((Number(item.duration) || 0) / 1000));
    if (duration && (duration < 45 || duration > 1200)) return null;
    // Длинные диджей-миксы — не «треки», в поток их не берём.
    if (duration > 600 && /\bmix\b/i.test(title)) return null;

    // Каталог отдаёт транскодинги уже в результатах поиска — сохраняем
    // ссылки, чтобы для запуска трека хватило одного запроса вместо двух.
    const transcodings = Array.isArray(item.media && item.media.transcodings)
      ? item.media.transcodings
      : [];
    const streams = transcodingCandidates(transcodings, item.policy);
    // Шифрованный HLS (Widevine/FairPlay) напрямую не играет, но официальный
    // плеер умеет его открывать — такие треки оставляем и уводим в фолбэк.
    const encrypted =
      !streams.length &&
      item.embeddable_by !== "none" &&
      transcodings.some(
        (transcoding) =>
          /encrypted-hls/i.test(String(transcoding?.format?.protocol || "")) &&
          transcoding.snipped !== true
      );
    // Превью, запрет и треки без единого потока в каталог не берём.
    if (transcodings.length && !streams.length && !encrypted) return null;

    return {
      id,
      title,
      artist: cleanArtist(item.user && item.user.username),
      duration,
      cover: coverFor(item.artwork_url || (item.user && item.user.avatar_url)),
      permalink: item.permalink_url || "",
      genre: item.genre || "",
      plays: Number(item.playback_count) || 0,
      album: null,
      stream: streams[0] || null,
      // Все варианты потока: если первый не отдался, пробуем следующие.
      streams,
      drm: encrypted,
    };
  };

  // Порядок предпочтения HLS-пресетов: сначала лучшее качество.
  const TRANSCODING_PRIORITY = { aac_160k: 0, aac_96k: 1, abr_sq: 2 };

  // Все пригодные для браузера варианты потока по убыванию качества.
  function transcodingCandidates(list, policy) {
    // SNIP/BLOCK — это 30-секундные превью, полный трек так не отдадут.
    const access = String(policy || "ALLOW").toUpperCase();
    if (access === "SNIP" || access === "BLOCK") return [];
    if (!Array.isArray(list)) return [];

    const usable = list.filter((item) => {
      if (!item || !item.url || item.snipped) return false;
      const protocol = String(item?.format?.protocol || "");
      if (protocol === "progressive") {
        return /mpeg|mp3/i.test(String(item.format.mime_type || ""));
      }
      return protocol === "hls";
    });

    const rank = (item) => {
      if (item.format.protocol === "progressive") return -1;
      return TRANSCODING_PRIORITY[item.preset] ?? 9;
    };

    return [...usable]
      .sort((a, b) => rank(a) - rank(b))
      .map((item) => ({ url: item.url, hls: item.format.protocol === "hls" }));
  }

  function pickTranscoding(list, policy) {
    return transcodingCandidates(list, policy)[0] || null;
  }

  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((track) => {
      if (!track || !track.id || seen.has(track.id)) return false;
      seen.add(track.id);
      return true;
    });
  };

  const isCachedTrack = (track) =>
    !!track &&
    typeof track.id === "string" &&
    /^\d+$/.test(track.id) &&
    typeof track.title === "string";

  /* =========================================================
     Поиск по каталогу
     ========================================================= */

  // Публичные прокси по порядку. r.jina.ai отдаёт CORS и понимает конверт
  // reader-а, но из России отвечает 451, поэтому приложение само переключается
  // на следующий прокси и запоминает рабочий до конца сессии.
  const DEFAULT_PROXIES = [
    "https://r.jina.ai/",
    "https://proxy.corsfix.com/?url=",
  ];

  const PROXY_LIST = (() => {
    const list = [];
    if (SC_CONFIG.proxy) list.push(SC_CONFIG.proxy);
    if (Array.isArray(SC_CONFIG.proxies)) {
      SC_CONFIG.proxies.filter(Boolean).forEach((item) => list.push(item));
    }
    if (!list.length) list.push(...DEFAULT_PROXIES);
    return [...new Set(list)];
  })();

  let proxyIndex = 0;
  try {
    const saved = Number(sessionStorage.getItem("kokky:proxy"));
    if (Number.isInteger(saved) && saved >= 0 && saved < PROXY_LIST.length) {
      proxyIndex = saved;
    }
  } catch (_) {
    /* ignore broken storage */
  }

  function proxyUrlAt(index, url) {
    // Воркер и corsfix принимают ссылку в ?url=, reader — прямо в пути.
    const template = PROXY_LIST[index] || PROXY_LIST[0];
    if (template.includes("?url=") || /[?&]$/.test(template)) {
      return `${template}${encodeURIComponent(url)}`;
    }
    return `${template}${url}`;
  }

  function useProxy(index) {
    proxyIndex = index;
    try {
      sessionStorage.setItem("kokky:proxy", String(index));
    } catch (_) {
      /* ignore */
    }
  }

  // Прокси может отдать чистый JSON, а может обернуть его в свой конверт
  // (r.jina.ai кладёт ответ в data.content строкой) — разворачиваем оба вида.
  function parsePayload(text) {
    const start = text.indexOf("{");
    if (start < 0) throw new Error("bad payload");

    let json = JSON.parse(text.slice(start));

    if (json && json.data && typeof json.data.content === "string") {
      const inner = json.data.content;
      const innerStart = inner.search(/[[{]/);
      if (innerStart >= 0) {
        try {
          json = JSON.parse(inner.slice(innerStart));
        } catch (_) {
          /* оставляем конверт как есть */
        }
      }
    }

    if (json && Number(json.code) === 429) {
      const limit = new Error("rate limited");
      limit.wait = Math.min(5000, (Number(json.retryAfter) || 2) * 1000 + 300);
      throw limit;
    }

    return json;
  }

  async function requestJson(url, signal, attempts = 3) {
    const start = proxyIndex;
    const perProxy = Math.max(1, attempts);
    let lastError = null;

    for (let round = 0; round < PROXY_LIST.length; round += 1) {
      const index = (start + round) % PROXY_LIST.length;

      for (let attempt = 0; attempt < perProxy; attempt += 1) {
        try {
          const response = await fetch(proxyUrlAt(index, url), {
            signal,
            headers: { Accept: "application/json, text/plain, */*" },
          });
          const text = await response.text();

          if (!response.ok) {
            // r.jina.ai на 429 присылает {"code":429,"retryAfter":N} —
            // ждём столько, сколько просят, и пробуем ещё раз.
            let wait = 900 + attempt * 900;
            try {
              const limit = JSON.parse(text);
              const retryAfter = Number(limit && limit.retryAfter);
              if (retryAfter > 0) wait = Math.min(5000, retryAfter * 1000 + 300);
            } catch (_) {
              /* not a json error */
            }
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            error.wait = wait;
            throw error;
          }

          useProxy(index);
          return parsePayload(text);
        } catch (error) {
          lastError = error;
          if (error.name === "AbortError") throw error;

          // 451/403 — прокси закрыт для страны, 5xx/сеть — сбой самого прокси.
          // Такие ошибки не лечатся ожиданием: сразу берём следующий прокси.
          if (error.status === 451 || error.status === 403) {
            if (PROXY_LIST.length > 1) {
              useProxy((index + 1) % PROXY_LIST.length);
            }
            break;
          }

          if (attempt === perProxy - 1) break;
          const wait = Math.min(5000, Number(error.wait) || 900 + attempt * 900);
          await new Promise((resolve) => window.setTimeout(resolve, wait));
        }
      }
    }

    throw lastError || new Error("proxy unavailable");
  }

  function scUrl(path, params) {
    const query = new URLSearchParams({ ...params, client_id: SC_CONFIG.clientId });
    return `${SC_CONFIG.api}${path}?${query.toString()}`;
  }

  async function searchSoundCloud(query, limit = 24, signal) {
    const json = await requestJson(
      scUrl("/search/tracks", {
        q: query,
        limit: String(Math.min(50, Math.max(1, limit))),
        linked_partitioning: "1",
      }),
      signal
    );

    const items = Array.isArray(json.collection) ? json.collection : [];
    // Сначала популярные: так в потоке меньше случайных загрузок.
    const sorted = [...items].sort(
      (a, b) => (Number(b.playback_count) || 0) - (Number(a.playback_count) || 0)
    );

    return dedupe(sorted.map(fromSoundCloud).filter(Boolean)).slice(0, limit);
  }

  function readFeedCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(STORE.feed) || "null");
      if (!cached || !Array.isArray(cached.tracks)) return { tracks: [], at: 0 };
      return {
        tracks: cached.tracks.filter(isCachedTrack),
        at: Number(cached.at) || 0,
      };
    } catch (_) {
      return { tracks: [], at: 0 };
    }
  }

  function writeFeedCache(tracks) {
    try {
      localStorage.setItem(
        STORE.feed,
        JSON.stringify({ at: Date.now(), tracks: tracks.slice(0, 60) })
      );
    } catch (_) {
      /* ignore */
    }
  }

  async function fetchFeed() {
    const seeds = feedSeeds();
    const queries = seeds.length
      ? [...seeds, ...FEED_QUERIES.slice(0, 3)]
      : FEED_QUERIES;

    const settled = await Promise.allSettled(
      queries.map((query) =>
        searchSoundCloud(query, 20, AbortSignal.timeout(20000))
      )
    );

    const lists = settled
      .map((result, index) => {
        if (result.status !== "fulfilled" || !result.value.length) return [];
        return index < seeds.length
          ? rankSeedResults(result.value, seeds[index])
          : result.value;
      })
      .filter((list) => list.length);

    if (!lists.length) throw new Error("feed unavailable");

    const merged = [];
    const seen = new Set();

    for (let index = 0; merged.length < 60; index += 1) {
      let added = false;
      for (const list of lists) {
        const track = list[index];
        if (!track) continue;
        added = true;
        if (seen.has(track.id)) continue;
        seen.add(track.id);
        merged.push(track);
        if (merged.length >= 60) break;
      }
      if (!added) break;
    }

    return merged;
  }

  /* =========================================================
     Player state
     ========================================================= */

  const state = {
    view: "stream",
    queue: [],
    index: 0,
    current: null,
    liked: new Set(),
    volume: 0.8,
    muted: false,
    closed: false,
    playing: false,
    started: false,
  };

  try {
    const savedLikes = JSON.parse(localStorage.getItem(STORE.liked) || "[]");
    if (Array.isArray(savedLikes)) state.liked = new Set(savedLikes);
  } catch (_) {
    /* ignore broken storage */
  }

  try {
    const savedVolume = Number.parseFloat(localStorage.getItem(STORE.volume));
    if (Number.isFinite(savedVolume)) {
      state.volume = Math.min(1, Math.max(0, savedVolume));
    }
  } catch (_) {
    /* ignore broken storage */
  }

  let userPlaylists = [];
  try {
    const savedPlaylists = JSON.parse(localStorage.getItem(STORE.playlists) || "[]");
    if (Array.isArray(savedPlaylists)) {
      userPlaylists = savedPlaylists.filter(
        (playlist) =>
          playlist &&
          typeof playlist.id === "string" &&
          typeof playlist.title === "string" &&
          Array.isArray(playlist.tracks)
      );
    }
  } catch (_) {
    /* ignore broken storage */
  }

  /* =========================================================
     Taste profile
     ========================================================= */

  const taste = { onboarded: false, artists: {}, queries: {}, genres: {} };

  try {
    const savedTaste = JSON.parse(localStorage.getItem(STORE.taste) || "null");
    if (savedTaste && typeof savedTaste === "object") {
      taste.onboarded = savedTaste.onboarded === true;
      ["artists", "queries", "genres"].forEach((bucket) => {
        const map = savedTaste[bucket];
        if (!map || typeof map !== "object") return;
        Object.entries(map).forEach(([name, score]) => {
          const clean = String(name || "").replace(/\s+/g, " ").trim();
          const value = Number(score);
          if (clean && Number.isFinite(value) && value > 0) {
            taste[bucket][clean] = Math.min(20, value);
          }
        });
      });
    }
  } catch (_) {
    /* ignore broken taste */
  }

  const tasteKey = (value) => normCompact(value);

  function tasteTop(bucket, limit = 3) {
    return Object.entries(taste[bucket])
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name]) => name);
  }

  function rememberTaste(bucket, value, weight = 1) {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    if (clean.length < 2) return;
    if (/^(неизвестно|неизвестный артист|без названия)$/i.test(clean)) return;

    taste[bucket][clean] = Math.min(20, (taste[bucket][clean] || 0) + weight);
    Object.entries(taste[bucket])
      .sort((a, b) => b[1] - a[1])
      .slice(12)
      .forEach(([name]) => delete taste[bucket][name]);
  }

  function saveTaste() {
    try {
      localStorage.setItem(STORE.taste, JSON.stringify(taste));
    } catch (_) {
      /* ignore */
    }
  }

  function feedSeeds() {
    const seeds = [];

    const add = (value) => {
      const clean = String(value || "").trim();
      const key = tasteKey(clean);
      if (!key || seeds.some((seed) => tasteKey(seed) === key)) return;
      seeds.push(clean);
    };

    tasteTop("artists", 3).forEach(add);
    tasteTop("queries", 2).forEach(add);
    tasteTop("genres", 1).forEach(add);
    return seeds.slice(0, 3);
  }

  // Для подборки по артисту поднимаем его официальные загрузки выше
  // перезаливов и ремиксов, даже если у тех больше прослушиваний.
  function rankSeedResults(list, seed) {
    const key = normCompact(seed);
    if (key.length < 2) return list;

    const curated = ARTISTS.find((artist) =>
      artistAliases(artist).some((alias) => normCompact(alias) === key)
    );
    const needles = curated ? artistNeedles(curated) : [key];
    const patterns = curated ? artistPatterns(curated) : null;
    const seedTitle = normText(seed).toLowerCase();

    const official = [];
    const titled = [];
    const rest = [];

    list.forEach((track) => {
      const user = normCompact(track.artist);
      const title = normText(track.title).toLowerCase();
      const userHit = needles.some((needle) => user.includes(needle));
      const titleHit = patterns
        ? patterns.some((pattern) => pattern.test(title))
        : title.startsWith(seedTitle);

      if (userHit) official.push(track);
      else if (titleHit) titled.push(track);
      else rest.push(track);
    });

    if (official.length) return [...official, ...titled, ...rest];
    if (titled.length) return [...titled, ...rest];
    return list;
  }

  const dom = {
    body: document.body,
    stage: $("#stage"),
    player: $("#player"),
    playerBody: $("#playerBody"),
    streamWelcome: $("#streamWelcome"),
    welcomeSearchBtn: $("#welcomeSearchBtn"),
    welcomeChips: $("#welcomeChips"),
    streamEyebrow: $("#streamEyebrow"),
    art: $(".art"),
    artNotice: $("#artNotice"),
    scPlayer: $("#scPlayer"),
    audio: $("#nativeAudio"),
    serverHelpBtn: $("#serverHelpBtn"),
    playerView: $("#view-stream"),
    views: {
      stream: $("#view-stream"),
      search: $("#view-search"),
      artists: $("#view-artists"),
      artist: $("#view-artist"),
      playlists: $("#view-playlists"),
      playlist: $("#view-playlist"),
    },
    navItems: $$(".nav__item"),
    playBtn: $("#playBtn"),
    prevBtn: $("#prevBtn"),
    nextBtn: $("#nextBtn"),
    seek: $("#seek"),
    seekFill: $("#seekFill"),
    seekLabel: $("#seekLabel"),
    seekTime: $("#seekTime"),
    cover: $("#coverImage"),
    artistName: $("#artistName"),
    trackTitle: $("#trackTitle"),
    likeBtns: $$(".like"),
    playlistBtn: $("#playlistBtn"),
    volumeBtn: $("#volumeBtn"),
    volumeRange: $("#volumeRange"),
    volumeValue: $("#volumeValue"),
    volumePop: $("#volumePop"),
    volumeWrap: $("#volumeWrap"),
    trackMenuBtn: $("#trackMenuBtn"),
    trackMenu: $("#trackMenu"),
    trackSourceLink: $("#trackSourceLink"),
    topMenuBtn: $("#topMenuBtn"),
    topMenu: $("#topMenu"),
    settingsBtn: $("#settingsBtn"),
    settingsMenu: $("#settingsMenu"),
    settingsItemMotion: $('[data-action="toggle-motion"]'),
    motionCheck: $("#motionCheck"),
    closeBtn: $("#closeBtn"),
    reopenBtn: $("#reopenBtn"),
    searchInput: $("#searchInput"),
    results: $("#results"),
    artists: $("#artists"),
    artistBack: $("#artistBack"),
    artistPageTitle: $("#artistPageTitle"),
    artistMeta: $("#artistMeta"),
    artistPlay: $("#artistPlay"),
    artistShuffle: $("#artistShuffle"),
    artistTracks: $("#artistTracks"),
    playlists: $("#playlists"),
    playlistBack: $("#playlistBack"),
    playlistTitle: $("#playlistTitle"),
    playlistMeta: $("#playlistMeta"),
    playlistPlay: $("#playlistPlay"),
    playlistAdd: $("#playlistAdd"),
    playlistTracks: $("#playlistTracks"),
    playlistDialog: $("#playlistDialog"),
    dialogTitle: $("#dialogTitle"),
    dialogBody: $("#dialogBody"),
    toast: $("#toast"),
    menuButtons: [$("#topMenuBtn"), $("#trackMenuBtn"), $("#settingsBtn")].filter(Boolean),
    menus: [$("#topMenu"), $("#trackMenu"), $("#settingsMenu")].filter(Boolean),
  };

  function syncWelcome() {
    const fresh = !taste.onboarded;
    if (dom.playerBody) dom.playerBody.hidden = fresh;
    if (dom.streamWelcome) dom.streamWelcome.hidden = !fresh;
    if (dom.streamEyebrow) {
      dom.streamEyebrow.textContent = taste.onboarded ? "Мой поток · под тебя" : "Мой поток";
    }
  }

  function openSearchWith(query = "") {
    dom.searchInput.value = query;
    setView("search");
  }

  function noteTasteChange(firstTime) {
    saveTaste();
    syncWelcome();
    scheduleFeedRefresh();
    if (firstTime) toast("поток подстроится под тебя");
  }

  function learnFromQuery(query) {
    const clean = String(query || "").trim();
    if (clean.length < 2) return;
    const firstTime = !taste.onboarded;
    rememberTaste("queries", clean);
    taste.onboarded = true;
    noteTasteChange(firstTime);
  }

  function learnFromPlay(track) {
    if (!track) return;
    const firstTime = !taste.onboarded;
    rememberTaste("artists", track.artist);
    if (track.genre) rememberTaste("genres", track.genre);
    taste.onboarded = true;
    noteTasteChange(firstTime);
  }

  dom.welcomeSearchBtn?.addEventListener("click", () => openSearchWith(""));
  dom.welcomeChips?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-query]");
    if (!chip) return;
    const query = chip.dataset.query || "";
    learnFromQuery(query);
    openSearchWith(query);
  });

  let rafId = null;
  let lastProgress = -1;
  let lastSecond = -1;
  let toastTimer = null;
  let scrubbing = false;

  /* =========================================================
     Helpers
     ========================================================= */

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return `${minutes}:${String(rest).padStart(2, "0")}`;
  };

  const tracksWord = (count) => {
    const last = count % 10;
    const lastTwo = count % 100;
    if (last === 1 && lastTwo !== 11) return "трек";
    if (last >= 2 && last <= 4 && (lastTwo < 10 || lastTwo >= 20)) return "трека";
    return "треков";
  };

  const isLiked = (track) => !!track && state.liked.has(track.id);

  function persistLikes() {
    try {
      localStorage.setItem(STORE.liked, JSON.stringify([...state.liked]));
    } catch (_) {
      /* ignore */
    }
  }

  function toast(message, duration = 2600) {
    dom.toast.textContent = message;
    dom.toast.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      dom.toast.classList.remove("is-visible");
    }, duration);
  }

  function guardCover(image, fallback = FALLBACK_COVER) {
    image.addEventListener(
      "error",
      () => {
        if (image.src !== fallback) image.src = fallback;
      },
      { once: false }
    );
  }

  /* =========================================================
     Menus
     ========================================================= */

  function closeMenus() {
    dom.menus.forEach((menu) => menu.classList.remove("is-open"));
    dom.menuButtons.forEach((button) => button.setAttribute("aria-expanded", "false"));
    dom.volumePop.classList.remove("is-open");
  }

  function toggleMenu(menu, button) {
    const willOpen = !menu.classList.contains("is-open");
    closeMenus();
    if (willOpen) {
      menu.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
    }
  }

  dom.topMenuBtn.addEventListener("click", () => toggleMenu(dom.topMenu, dom.topMenuBtn));
  dom.trackMenuBtn.addEventListener("click", () => toggleMenu(dom.trackMenu, dom.trackMenuBtn));
  if (dom.settingsBtn && dom.settingsMenu) {
    dom.settingsBtn.addEventListener("click", () => {
      toggleMenu(dom.settingsMenu, dom.settingsBtn);
      syncMotionUI();
    });
  }

  document.addEventListener("pointerdown", (event) => {
    if (
      !event.target.closest(".menu") &&
      !event.target.closest('[aria-haspopup="menu"]') &&
      !event.target.closest(".volume-wrap")
    ) {
      closeMenus();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenus();
      if (dom.playlistDialog && !dom.playlistDialog.hidden) closeDialog();
    }
  });

  dom.menus.forEach((menu) => {
    menu.addEventListener("click", (event) => {
      if (event.target.closest("a, button")) closeMenus();
    });
  });

  /* =========================================================
     Toast actions
     ========================================================= */

  document.addEventListener("click", (event) => {
    const actionEl = event.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === "shortcuts") {
      toast("space — пауза · ← → — 5 сек · ↑ ↓ — звук");
    }

    if (action === "about") {
      toast("kokky · полные треки · без аккаунта");
    }

    if (action === "add-to-playlist") {
      openAddToPlaylist();
    }

    if (action === "copy-link") {
      if (!state.current) return;
      const url = state.current.permalink || library.source.url;
      copyText(url).then((ok) => {
        toast(ok ? "ссылка скопирована" : "не удалось скопировать");
      });
    }

    if (action === "toggle-motion") {
      const reduced = !dom.body.classList.contains("reduce-motion");
      dom.body.classList.toggle("reduce-motion", reduced);
      try {
        localStorage.setItem(STORE.motion, reduced ? "1" : "0");
      } catch (_) {
        /* ignore */
      }
      syncMotionUI();
      toast(reduced ? "анимации уменьшены" : "анимации включены");
    }

    if (action === "clear-likes") {
      state.liked.clear();
      persistLikes();
      syncLikeButtons(false);
      toast("избранное очищено");
    }
  });

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {
      /* fall through to legacy copy */
    }

    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  /* =========================================================
     Player UI
     ========================================================= */

  function updateTrackUI(track) {
    const artist = track.artist || library.source.name;

    dom.cover.src = track.cover || FALLBACK_COVER;
    dom.cover.alt = `${track.title} — ${artist}`;
    dom.artistName.textContent = artist;
    dom.artistName.classList.toggle("is-long", artist.length > 18);
    dom.trackTitle.textContent = track.title;
    dom.seekLabel.textContent = `${artist} — ${track.title}`;
    dom.trackSourceLink.href = track.permalink || library.source.url;
    dom.playlistBtn.disabled = false;
    document.title = `${track.title} — ${artist} · kokky`;

    syncLikeButtons(false);
    markCurrentRow();
    updateMediaSession(track);
    resetProgressUI();
  }

  function resetProgressUI() {
    const duration = state.current?.duration || 0;
    lastProgress = -1;
    lastSecond = -1;
    dom.seekFill.style.width = "0%";
    dom.seekTime.textContent = `0:00 / ${formatTime(duration)}`;
    dom.seek.setAttribute("aria-valuenow", "0");
    dom.seek.setAttribute("aria-valuemax", String(Math.max(1, Math.round(duration))));
  }

  function updateProgress() {
    const duration = getDuration();
    const current = duration > 0 ? Math.min(getCurrentTime(), duration) : 0;
    const percent = duration > 0 ? (current / duration) * 100 : 0;
    const second = Math.floor(current);

    if (Math.abs(percent - lastProgress) > 0.03) {
      dom.seekFill.style.width = `${percent.toFixed(2)}%`;
      lastProgress = percent;
    }

    if (second !== lastSecond) {
      dom.seekTime.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
      dom.seek.setAttribute("aria-valuenow", String(second));
      dom.seek.setAttribute("aria-valuemax", String(Math.max(1, Math.round(duration))));
      lastSecond = second;
    }
  }

  function startTicker() {
    if (rafId) return;
    const tick = () => {
      updateProgress();
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
  }

  function stopTicker() {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    updateProgress();
  }

  function syncPlayState() {
    const playing = !!state.playing;
    dom.body.classList.toggle("is-playing", playing);
    dom.playBtn.setAttribute("aria-label", playing ? "Пауза" : "Играть");
  }

  function syncLikeButtons(animate) {
    const liked = isLiked(state.current);
    dom.likeBtns.forEach((button) => {
      button.classList.toggle("is-liked", liked);
      button.setAttribute("aria-pressed", liked ? "true" : "false");
      button.setAttribute("aria-label", liked ? "Убрать из избранного" : "В избранное");
      if (animate && liked) {
        button.classList.remove("is-liked");
        void button.offsetWidth;
        button.classList.add("is-liked");
      }
    });
  }

  function toggleLike() {
    if (!state.current) return;
    const adding = !state.liked.has(state.current.id);
    if (adding) {
      state.liked.add(state.current.id);
      learnFromPlay(state.current);
    } else {
      state.liked.delete(state.current.id);
    }
    persistLikes();
    syncLikeButtons(true);
  }

  dom.likeBtns.forEach((button) => button.addEventListener("click", toggleLike));

  /* =========================================================
     Volume
     ========================================================= */

  function applyVolume(persist = false) {
    const percent = Math.round(state.volume * 100);

    if (nativeAudio) {
      nativeAudio.volume = state.muted ? 0 : Math.min(1, Math.max(0, state.volume));
      nativeAudio.muted = !!state.muted;
    }

    if (scReady && scWidget) {
      try {
        scWidget.setVolume(state.muted || state.volume === 0 ? 0 : percent);
      } catch (_) {
        /* player is not ready yet */
      }
    }

    dom.volumeRange.value = String(percent);
    dom.volumeRange.style.setProperty("--vol", `${percent}%`);
    dom.volumeValue.textContent = String(percent);
    dom.volumeBtn.classList.toggle("is-muted", state.muted || state.volume === 0);
    dom.volumeBtn.setAttribute("aria-pressed", state.muted ? "true" : "false");
    dom.volumeBtn.setAttribute(
      "aria-label",
      state.muted || state.volume === 0 ? "Включить звук" : "Выключить звук"
    );

    if (persist) {
      try {
        localStorage.setItem(STORE.volume, String(state.volume));
      } catch (_) {
        /* ignore */
      }
    }
  }

  dom.volumeBtn.addEventListener("click", () => {
    if (state.muted || state.volume === 0) {
      state.muted = false;
      if (state.volume === 0) state.volume = 0.6;
    } else {
      state.muted = true;
    }
    applyVolume(true);
    dom.volumePop.classList.add("is-open");
  });

  dom.volumeRange.addEventListener("input", () => {
    const value = Number(dom.volumeRange.value) / 100;
    state.volume = Math.min(1, Math.max(0, value));
    state.muted = false;
    applyVolume(true);
    dom.volumePop.classList.add("is-open");
  });

  dom.volumeRange.addEventListener("pointerdown", () => {
    dom.volumePop.classList.add("is-open");
  });

  /* =========================================================
     Плеер
     ========================================================= */

  // Звук играет нативный <audio>: он не зависит от заблокированного
  // домена с виджетом и работает через прокси каталога. Виджет остаётся
  // запасным вариантом, если прямой поток получить не удалось.
  const engine = { current: "native" };
  const nativeAudio = dom.audio;

  let hlsEngine = null;
  let nativeActive = false;
  let nativeAutoplay = false;
  let nativeToken = 0;
  let nativeFailures = 0;

  let scWidget = null;
  let scReady = false;
  let widgetCued = false;
  let scDuration = 0;
  let scPosition = 0;
  let pendingCue = null;
  let errorStreak = 0;
  let widgetApiPromise = null;

  function getDuration() {
    if (engine.current === "native" && nativeActive) {
      const live = nativeAudio ? nativeAudio.duration : 0;
      if (Number.isFinite(live) && live > 0) return live;
    }
    if (Number.isFinite(scDuration) && scDuration > 0) return scDuration;
    return state.current?.duration || 0;
  }

  function getCurrentTime() {
    if (engine.current === "native" && nativeActive && nativeAudio) {
      const live = nativeAudio.currentTime;
      if (Number.isFinite(live) && live >= 0) return live;
    }
    return scPosition;
  }

  function setPosition(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return;
    const seconds = Math.max(0, value / 1000);
    if (engine.current === "native" && nativeActive) {
      scDuration = getDuration();
    }
    scPosition = seconds;
    updateProgress();
  }

  function destroyHls() {
    if (!hlsEngine) return;
    try {
      hlsEngine.destroy();
    } catch (_) {
      /* ignore */
    }
    hlsEngine = null;
  }

  function detachNative() {
    nativeActive = false;
    nativeAutoplay = false;
    nativeToken += 1;
    destroyHls();
    if (!nativeAudio) return;
    try {
      nativeAudio.pause();
    } catch (_) {
      /* ignore */
    }
    nativeAudio.removeAttribute("src");
    try {
      nativeAudio.load();
    } catch (_) {
      /* ignore */
    }
  }

  const STREAM_TTL = 8 * 60 * 1000;
  const STREAM_PREFIX = "kokky:stream:sc:";
  const streamCache = new Map();

  function readStreamCache(id) {
    const live = streamCache.get(id);
    if (live && live.at + STREAM_TTL > Date.now()) return live.data;

    try {
      const saved = JSON.parse(localStorage.getItem(STREAM_PREFIX + id) || "null");
      if (!saved || !saved.url) return null;
      if (Number(saved.expires) < Date.now() + 60000) return null;
      const data = { url: saved.url, hls: !!saved.hls };
      streamCache.set(id, { at: Date.now(), data });
      return data;
    } catch (_) {
      return null;
    }
  }

  function writeStreamCache(id, data) {
    streamCache.set(id, { at: Date.now(), data });

    let expires = Date.now() + STREAM_TTL;
    try {
      const stamp = Number(new URL(data.url).searchParams.get("expires"));
      if (stamp > 0) expires = stamp * 1000;
    } catch (_) {
      /* ignore */
    }

    try {
      localStorage.setItem(
        STREAM_PREFIX + id,
        JSON.stringify({ url: data.url, hls: !!data.hls, expires })
      );
    } catch (_) {
      /* ignore quota */
    }
  }

  // Ссылка на медиа: сначала используем транскодинг из поиска, а если его нет,
  // он устарел или не отдался — запрашиваем трек целиком и пробуем остальные
  // варианты. Перебираем всё, что играет в браузере, прежде чем сдаться.
  async function resolveStream(track) {
    // DRM-поток (Widevine/FairPlay) браузеру не отдать — его играет только
    // официальный плеер, поэтому сразу уводим трек туда.
    if (track.drm) return "drm";

    const cached = readStreamCache(track.id);
    if (cached) return cached;

    const signal = AbortSignal.timeout(15000);
    const seen = new Set();

    const attempt = async (list) => {
      for (const candidate of list) {
        if (!candidate || !candidate.url || seen.has(candidate.url)) continue;
        seen.add(candidate.url);
        try {
          const media = await requestJson(withClientId(candidate.url), signal, 1);
          if (media && media.url) {
            const data = { url: media.url, hls: !!candidate.hls };
            writeStreamCache(track.id, data);
            return data;
          }
        } catch (_) {
          /* пробуем следующий вариант */
        }
      }
      return null;
    };

    const candidates = [
      ...(Array.isArray(track.streams) ? track.streams : []),
      ...(track.stream && track.stream.url ? [track.stream] : []),
    ];

    const fromSearch = await attempt(candidates);
    if (fromSearch) return fromSearch;

    let details = null;
    try {
      details = await requestJson(scUrl(`/tracks/${track.id}`, {}), signal, 2);
    } catch (_) {
      return null;
    }

    const transcodings =
      details && details.media && Array.isArray(details.media.transcodings)
        ? details.media.transcodings
        : [];
    const fresh = transcodingCandidates(transcodings, details && details.policy);
    const fromDetails = await attempt(fresh);
    if (fromDetails) return fromDetails;

    const encrypted =
      details &&
      details.embeddable_by !== "none" &&
      transcodings.some(
        (item) =>
          /encrypted-hls/i.test(String(item?.format?.protocol || "")) &&
          item.snipped !== true
      );
    if (encrypted) return "drm";

    // Превью и запрещённые треки не отдадут полную длину — их не спасает
    // даже официальный плеер, поэтому честно пропускаем.
    const access = String((details && details.policy) || "").toUpperCase();
    if (access === "SNIP" || access === "BLOCK" || !transcodings.length) {
      return "unavailable";
    }

    // Варианты были, но ни один не отдался (регион, сеть) — пусть попробует
    // официальный плеер: иногда у него другой маршрут к медиа.
    return null;
  }

  let prefetchTimer = 0;

  // Следующий трек греем заранее: два запроса к каталогу идут, пока играет
  // текущий, и переключение не упирается в ожидание.
  function prefetchNext() {
    window.clearTimeout(prefetchTimer);
    if (engine.current !== "native" || state.queue.length < 2) return;

    prefetchTimer = window.setTimeout(() => {
      if (engine.current !== "native") return;
      const next = state.queue[(state.index + 1) % state.queue.length];
      if (!next || !/^\d+$/.test(String(next.id || ""))) return;
      if (readStreamCache(next.id)) return;
      resolveStream(next).catch(() => {});
    }, 1800);
  }

  function setBuffering(value) {
    state.buffering = !!value;
    dom.playBtn.classList.toggle("is-loading", !!value);
    dom.playBtn.setAttribute(
      "aria-label",
      value ? "Загружаем трек" : state.playing ? "Пауза" : "Играть"
    );
  }

  // Официальный плеер — последний аргумент: он умеет DRM-потоки и иногда
  // играет там, где прямой поток не отдался. Держим его как фолбэк, а не как
  // основной движок, и возвращаемся к нативному на следующем треке.
  async function attemptWidget(track, { autoplay = false } = {}) {
    if (!track) return false;
    if (!(await ensureWidget())) {
      engine.current = "native";
      return false;
    }
    // Пока грузился официальный плеер, пользователь мог выбрать другой трек.
    if (track !== state.current) return true;
    // Нативный поток мог успеть начаться — глушим его, чтобы не играли два.
    detachNative();
    engine.current = "widget";
    cueWidget(track, { autoplay });
    return true;
  }

  function forgetStream(id) {
    streamCache.delete(id);
    try {
      localStorage.removeItem(STREAM_PREFIX + id);
    } catch (_) {
      /* ignore */
    }
  }

  // Если медиа-CDN закрыт у провайдера, гоним сам поток через CORS-прокси:
  // для MP3 — подменой src, для HLS — своим загрузчиком, который переписывает
  // каждый запрос (плейлист, init, сегменты) на прокси.
  let proxiedTrackId = "";
  let mediaLoaderClass = null;
  let mediaLoaderSource = null;

  function proxyMediaUrl(url) {
    const template = SC_CONFIG.mediaProxy;
    if (!template || !url) return url;
    if (url.startsWith(template)) return url;
    return `${template}${encodeURIComponent(url)}`;
  }

  function proxiedHlsLoader(Hls) {
    if (mediaLoaderClass && mediaLoaderSource === Hls) return mediaLoaderClass;
    const Base = Hls && Hls.DefaultConfig && Hls.DefaultConfig.loader;
    if (typeof Base !== "function") return null;
    mediaLoaderClass = class extends Base {
      load(context, config, callbacks) {
        if (context && context.url) context.url = proxyMediaUrl(context.url);
        super.load(context, config, callbacks);
      }
    };
    mediaLoaderSource = Hls;
    return mediaLoaderClass;
  }

  // Порядок последних попыток: проксированный поток, затем официальный плеер.
  async function fallbackPlayback(track, { autoplay = true } = {}) {
    if (!track) return;

    if (!track.drm && proxiedTrackId !== track.id) {
      proxiedTrackId = track.id;
      const result = await startNative(track, { autoplay, proxy: true });
      if (track !== state.current) return;
      if (result === "ok") return;
      if (result === "skip") {
        handlePlayerError();
        return;
      }
    }

    if (await attemptWidget(track, { autoplay })) return;
    handlePlayerError();
  }

  function nativeFailed() {
    nativeFailures += 1;
    // Ссылка могла протухнуть — в следующий раз возьмём свежую.
    if (state.current) forgetStream(state.current.id);
    detachNative();
    setBuffering(false);
    state.playing = false;
    syncPlayState();

    const track = state.current;
    if (!track) return;

    // Прямой поток не пошёл даже через прокси — остаётся официальный плеер.
    if (proxiedTrackId === track.id) {
      nativeFailures = 0;
      attemptWidget(track, { autoplay: true }).then((ok) => {
        if (!ok) handlePlayerError();
      });
      return;
    }

    if (nativeFailures >= 2) {
      nativeFailures = 0;
      fallbackPlayback(track);
      return;
    }

    // Первый сбой — пробуем тот же трек ещё раз со свежей ссылкой.
    window.setTimeout(() => {
      if (track === state.current && engine.current === "native") {
        cueTrack(track, { autoplay: true });
      }
    }, 400);
  }

  async function startNative(track, { autoplay = false, proxy = false } = {}) {
    if (!nativeAudio) return false;

    const useMediaProxy = !!proxy && !!SC_CONFIG.mediaProxy;

    const token = ++nativeToken;
    detachNative();
    nativeToken = token;
    nativeAutoplay = !!autoplay;
    scDuration = track.duration || 0;
    scPosition = 0;
    resetProgressUI();
    if (!readStreamCache(track.id)) setBuffering(true);

    let stream = null;
    try {
      stream = await resolveStream(track);
    } catch (_) {
      stream = null;
    }
    if (token !== nativeToken) return "ok";
    if (stream === "unavailable") {
      setBuffering(false);
      return "skip";
    }
    if (stream === "drm") {
      setBuffering(false);
      return "drm";
    }
    if (!stream) {
      setBuffering(false);
      return false;
    }

    if (stream.hls) {
      // Safari/iOS играет HLS сам, остальным нужен hls.js поверх MSE.
      // Chromium на этот тип отвечает «maybe», но сегменты не тянет — верим
      // только твёрдому «probably».
      const nativeHls =
        nativeAudio.canPlayType("application/vnd.apple.mpegurl") === "probably";
      if (!(window.Hls && window.Hls.isSupported())) {
        // Нативный HLS не умеет переписывать сегменты на прокси — там, где
        // нужен медиа-прокси, остаётся официальный плеер.
        if (!nativeHls || useMediaProxy) {
          setBuffering(false);
          return false;
        }
        nativeAudio.src = stream.url;
        nativeActive = true;
        nativeAudio.volume = state.muted ? 0 : state.volume;
        nativeAudio.muted = !!state.muted;
        state.started = true;
        prefetchNext();
        return "ok";
      }
      const MediaLoader = useMediaProxy ? proxiedHlsLoader(window.Hls) : null;
      if (useMediaProxy && !MediaLoader) {
        setBuffering(false);
        return false;
      }
      try {
        hlsEngine = new window.Hls({
          enableWorker: true,
          maxBufferLength: 30,
          backBufferLength: 60,
          ...(MediaLoader
            ? { loader: MediaLoader, pLoader: MediaLoader, fLoader: MediaLoader }
            : {}),
        });
        hlsEngine.on(window.Hls.Events.ERROR, (_event, data) => {
          if (!data || !data.fatal) return;
          if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && hlsEngine) {
            try {
              hlsEngine.recoverMediaError();
              return;
            } catch (_) {
              /* ignore */
            }
          }
          if (engine.current === "native" && nativeActive) nativeFailed();
        });
        hlsEngine.loadSource(stream.url);
        hlsEngine.attachMedia(nativeAudio);
      } catch (_) {
        destroyHls();
        setBuffering(false);
        return false;
      }
    } else {
      nativeAudio.src = useMediaProxy ? proxyMediaUrl(stream.url) : stream.url;
    }

    nativeActive = true;
    nativeAudio.volume = state.muted ? 0 : state.volume;
    nativeAudio.muted = !!state.muted;
    state.started = true;
    prefetchNext();
    return "ok";
  }

  async function cueTrack(track, { autoplay = false } = {}) {
    if (FILE_MODE || !track) return;

    if (!/^\d+$/.test(String(track.id || ""))) {
      toast("этот трек нельзя включить · выберите другой");
      return;
    }

    pendingCue = null;
    // Пользователь уже выбрал трек: лента не должна подменять его, пока
    // ссылка на поток ещё запрашивается.
    state.started = true;
    // Новый выбор — снова начинаем с прямого потока.
    proxiedTrackId = "";

    // DRM-поток иначе не открыть — его играет официальный плеер.
    if (track.drm) {
      if (await attemptWidget(track, { autoplay })) return;
      handlePlayerError();
      return;
    }

    // Прошлый трек мог играть через официальный плеер — останавливаем его.
    if (engine.current === "widget" && scWidget && scReady) {
      try {
        scWidget.pause();
      } catch (_) {
        /* ignore */
      }
    }

    // Основной путь — прямой поток. Официальный плеер оставляем на случай,
    // если каталог не отдал ссылку или браузер не тянет поток.
    engine.current = "native";

    let result = await startNative(track, { autoplay });
    if (track !== state.current) return;
    if (result === "ok") return;
    if (result === "skip") {
      handlePlayerError();
      return;
    }
    if (result === "drm") {
      if (await attemptWidget(track, { autoplay })) return;
      handlePlayerError();
      return;
    }

    // Прокси каталога иногда отвечает 429 — одна короткая повторная попытка.
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    if (track !== state.current) return;
    result = await startNative(track, { autoplay });
    if (track !== state.current) return;
    if (result === "ok") return;
    if (result === "skip") {
      handlePlayerError();
      return;
    }
    if (result === "drm") {
      if (await attemptWidget(track, { autoplay })) return;
      handlePlayerError();
      return;
    }

    // Прямой поток не отдался — пробуем официальный плеер для этого трека.
    if (await attemptWidget(track, { autoplay })) return;
    if (track !== state.current) return;

    setBuffering(false);
    engine.current = "native";
    toast("не удалось включить трек · проверьте соединение");
    handlePlayerError();
  }

  function cueWidget(track, { autoplay = false } = {}) {
    if (FILE_MODE || !track) return;

    if (!scWidget || !scReady) {
      pendingCue = { track, autoplay };
      return;
    }

    pendingCue = null;
    state.started = true;
    widgetCued = true;
    scDuration = track.duration || 0;
    scPosition = 0;
    resetProgressUI();
    setBuffering(false);

    try {
      scWidget.load(`https://api.soundcloud.com/tracks/${track.id}`, {
        auto_play: !!autoplay,
        hide_related: true,
        show_comments: false,
        show_user: false,
        show_reposts: false,
        show_artwork: false,
        visual: false,
        download: false,
        sharing: false,
        callback: () => {
          try {
            scWidget.getDuration((ms) => {
              if (Number(ms) > 0) {
                scDuration = Number(ms) / 1000;
                resetProgressUI();
              }
            });
            if (autoplay) scWidget.play();
          } catch (_) {
            /* ignore */
          }
        },
      });
    } catch (_) {
      toast("не удалось включить трек · попробуйте ещё раз");
    }
  }

  function loadTrack(track, { autoplay = false } = {}) {
    if (!track) return;
    state.current = track;

    updateTrackUI(track);
    cueTrack(track, { autoplay });
  }

  function playAudio({ silent = false } = {}) {
    if (FILE_MODE) {
      openServerHelp();
      return;
    }

    if (!state.current) return;

    if (engine.current === "native") {
      if (!nativeActive) {
        cueTrack(state.current, { autoplay: true });
        return;
      }
      try {
        const started = nativeAudio.play();
        if (started && typeof started.catch === "function") {
          started.catch(() => syncPlayState());
        }
      } catch (_) {
        if (!silent) toast("не удалось включить трек · проверьте соединение");
      }
      return;
    }

    if (!scWidget || !scReady) {
      pendingCue = { track: state.current, autoplay: true };
      return;
    }

    try {
      scWidget.play();
    } catch (_) {
      if (!silent) toast("не удалось включить трек · проверьте соединение");
    }
  }

  function pauseAudio() {
    if (engine.current === "native") {
      nativeAutoplay = false;
      if (nativeActive) {
        try {
          nativeAudio.pause();
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }

    if (!scReady || !scWidget) return;
    try {
      scWidget.pause();
    } catch (_) {
      /* ignore */
    }
  }

  function togglePlay() {
    if (FILE_MODE) {
      openServerHelp();
      return;
    }

    if (!state.current) return;

    if (!taste.onboarded) {
      openSearchWith(dom.searchInput.value.trim());
      return;
    }

    if (state.playing) {
      pauseAudio();
      return;
    }

    if (engine.current === "native" && !nativeActive) {
      cueTrack(state.current, { autoplay: true });
    } else {
      playAudio();
    }
  }

  function openPlayer() {
    if (!state.closed) return;
    state.closed = false;
    dom.playerView.classList.remove("is-closed");
    dom.stage.classList.remove("is-idle");
  }

  function closePlayer() {
    if (state.closed) return;
    state.closed = true;
    pauseAudio();
    setView("stream");
    dom.playerView.classList.add("is-closed");
    dom.stage.classList.add("is-idle");
    closeMenus();
  }

  function step(direction) {
    if (!state.queue.length) return;
    const wasPlaying = state.playing;
    state.index = (state.index + direction + state.queue.length) % state.queue.length;
    loadTrack(state.queue[state.index], { autoplay: wasPlaying });
  }

  function playTrack(track, queue = feed) {
    if (FILE_MODE) {
      openServerHelp();
      return;
    }

    const list = queue.filter(Boolean);
    let index = list.findIndex((item) => item.id === track.id);
    // Результаты могли перерисоваться между кликом и обработчиком — тогда
    // включаем именно выбранный трек, а не первый из старого списка.
    if (index < 0) {
      list.unshift(track);
      index = 0;
    }
    state.queue = list;
    state.index = index;
    openPlayer();
    loadTrack(list[index], { autoplay: true });
    learnFromPlay(list[index]);
    setView("stream");
  }

  function startQueue(queue, startIndex = 0) {
    if (FILE_MODE) {
      openServerHelp();
      return;
    }

    const list = queue.filter(Boolean);
    if (!list.length) return;
    const index = Math.min(Math.max(0, startIndex), list.length - 1);
    state.queue = list;
    state.index = index;
    openPlayer();
    loadTrack(list[index], { autoplay: true });
    learnFromPlay(list[index]);
    setView("stream");
  }

  function playUserPlaylist(playlist, startIndex = 0) {
    if (!playlist.tracks.length) {
      toast("плейлист пуст · добавьте первый трек");
      return;
    }
    startQueue(
      playlist.tracks.map((track, index) => ({
        ...track,
        album: playlist.title,
        albumId: playlist.id,
        cover: track.cover || FALLBACK_COVER,
        trackNo: index + 1,
      })),
      startIndex
    );
  }

  dom.playBtn.addEventListener("click", togglePlay);
  dom.nextBtn.addEventListener("click", () => step(1));
  dom.prevBtn.addEventListener("click", () => {
    if (getCurrentTime() > 3) {
      seekTo(0);
      updateProgress();
      return;
    }
    step(-1);
  });

  dom.closeBtn.addEventListener("click", closePlayer);
  dom.reopenBtn.addEventListener("click", openPlayer);

  /* =========================================================
     Seek
     ========================================================= */

  function seekTo(seconds) {
    const value = Math.max(0, seconds);

    if (engine.current === "native" && nativeActive) {
      try {
        nativeAudio.currentTime = value;
        scPosition = value;
      } catch (_) {
        /* ignore */
      }
      return;
    }

    if (!scReady || !scWidget) return;
    try {
      scWidget.seekTo(value * 1000);
      scPosition = value;
    } catch (_) {
      /* ignore */
    }
  }

  function seekToRatio(ratio) {
    const duration = getDuration();
    if (!Number.isFinite(duration) || duration <= 0) return;
    const clamped = Math.min(1, Math.max(0, ratio));
    seekTo(clamped * duration);
    updateProgress();
  }

  function seekFromPointer(event) {
    const rect = dom.seek.getBoundingClientRect();
    if (rect.width === 0) return;
    seekToRatio((event.clientX - rect.left) / rect.width);
  }

  dom.seek.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    scrubbing = true;
    dom.seek.setPointerCapture?.(event.pointerId);
    seekFromPointer(event);
  });

  dom.seek.addEventListener("pointermove", (event) => {
    if (scrubbing) seekFromPointer(event);
  });

  const endScrub = (event) => {
    if (!scrubbing) return;
    scrubbing = false;
    if (dom.seek.hasPointerCapture?.(event.pointerId)) {
      dom.seek.releasePointerCapture(event.pointerId);
    }
    seekFromPointer(event);
  };

  dom.seek.addEventListener("pointerup", endScrub);
  dom.seek.addEventListener("pointercancel", () => {
    scrubbing = false;
  });

  dom.seek.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      seekToRatio((getCurrentTime() + 5) / getDuration());
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      seekToRatio((getCurrentTime() - 5) / getDuration());
    }
    if (event.key === "Home") {
      event.preventDefault();
      seekToRatio(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      seekToRatio(1);
    }
  });

  /* =========================================================
     Жизненный цикл плеера
     ========================================================= */

  function handlePlayerReady() {
    scReady = true;
    applyVolume();

    const cue = pendingCue;
    pendingCue = null;

    if (cue && cue.track) {
      cueTrack(cue.track, { autoplay: !!cue.autoplay });
    }
  }

  function handlePlay() {
    errorStreak = 0;
    if (engine.current === "native") nativeFailures = 0;
    state.playing = true;
    setBuffering(false);
    syncPlayState();
    startTicker();
    updateProgress();
  }

  function handlePause() {
    state.playing = false;
    setBuffering(false);
    syncPlayState();
    stopTicker();
  }

  function handleFinish() {
    state.playing = false;
    syncPlayState();
    stopTicker();

    if (state.queue.length > 1) {
      state.index = (state.index + 1) % state.queue.length;
      loadTrack(state.queue[state.index], { autoplay: true });
    } else {
      seekTo(0);
      updateProgress();
    }
  }

  function handlePlayerError() {
    // Пустой виджет на старте тоже умеет присылать ERROR — не пугаем
    // пользователя тостом, пока в него не загрузили трек.
    if (engine.current === "widget" && !widgetCued) return;

    state.playing = false;
    syncPlayState();

    if (engine.current === "widget") {
      // Официальный плеер не справился (или недоступен без VPN) — на
      // следующем треке снова пробуем прямой поток.
      engine.current = "native";
    }

    toast("трек недоступен · включаем следующий");

    errorStreak += 1;
    if (errorStreak > 5) {
      errorStreak = 0;
      toast("несколько треков подряд недоступны · попробуйте поиск");
      return;
    }

    if (state.queue.length > 1) {
      window.setTimeout(() => step(1), 700);
    }
  }

  function wireNativeEvents() {
    if (!nativeAudio) return;

    nativeAudio.addEventListener("play", () => {
      if (engine.current !== "native") return;
      handlePlay();
    });

    nativeAudio.addEventListener("pause", () => {
      if (engine.current !== "native" || !nativeActive) return;
      handlePause();
    });

    nativeAudio.addEventListener("ended", () => {
      if (engine.current !== "native") return;
      nativeAutoplay = false;
      handleFinish();
    });

    nativeAudio.addEventListener("loadedmetadata", () => {
      if (engine.current !== "native" || !nativeActive) return;
      const live = nativeAudio.duration;
      if (Number.isFinite(live) && live > 0) {
        scDuration = live;
        resetProgressUI();
      }
    });

    nativeAudio.addEventListener("canplay", () => {
      if (engine.current !== "native" || !nativeActive || !nativeAutoplay) return;
      nativeAutoplay = false;
      try {
        const started = nativeAudio.play();
        if (started && typeof started.catch === "function") {
          started.catch(() => syncPlayState());
        }
      } catch (_) {
        /* ignore */
      }
    });

    nativeAudio.addEventListener("timeupdate", () => {
      if (engine.current !== "native" || !nativeActive) return;
      setPosition(nativeAudio.currentTime * 1000);
    });

    nativeAudio.addEventListener("error", () => {
      if (engine.current !== "native" || !nativeActive) return;
      nativeFailed();
    });
  }

  function loadWidgetApi() {
    if (window.SC && window.SC.Widget) return Promise.resolve();
    if (widgetApiPromise) return widgetApiPromise;

    widgetApiPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://w.soundcloud.com/player/api.js";
      script.async = true;
      script.addEventListener("load", () => resolve());
      script.addEventListener("error", () => reject(new Error("widget api")));
      document.head.appendChild(script);
    });

    return widgetApiPromise;
  }

  async function waitForWidgetApi(timeout = 5000) {
    const started = Date.now();
    while (
      (!window.SC || typeof window.SC.Widget !== "function") &&
      Date.now() - started < timeout
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return !!window.SC && typeof window.SC.Widget === "function";
  }

  let widgetLoading = null;

  // Виджет грузим только когда он действительно понадобился: его домен
  // недоступен без VPN, а нативный поток работает напрямую.
  async function ensureWidget() {
    if (FILE_MODE) return false;
    if (scWidget) return true;
    if (widgetLoading) return widgetLoading;

    widgetLoading = (async () => {
      try {
        await loadWidgetApi();
      } catch (_) {
        return false;
      }

      if (!(await waitForWidgetApi())) return false;
      if (!dom.scPlayer) return false;

      dom.scPlayer.src =
        "https://w.soundcloud.com/player/?url=&auto_play=false&hide_related=true" +
        "&show_comments=false&show_user=false&show_reposts=false&visual=false";

      try {
        scWidget = window.SC.Widget(dom.scPlayer);
        scWidget.bind(window.SC.Widget.Events.READY, handlePlayerReady);
        // События резервного плеера слушаем только пока он действительно
        // играет: иначе запоздавший ERROR/PAUSE старого виджета ломал бы
        // нативное воспроизведение следующего трека.
        scWidget.bind(window.SC.Widget.Events.PLAY, () => {
          if (engine.current === "widget") handlePlay();
        });
        scWidget.bind(window.SC.Widget.Events.PAUSE, () => {
          if (engine.current === "widget") handlePause();
        });
        scWidget.bind(window.SC.Widget.Events.FINISH, () => {
          if (engine.current === "widget") handleFinish();
        });
        scWidget.bind(window.SC.Widget.Events.ERROR, () => {
          if (engine.current === "widget") handlePlayerError();
        });
        scWidget.bind(window.SC.Widget.Events.PLAY_PROGRESS, (event) => {
          if (
            engine.current === "widget" &&
            event &&
            typeof event.currentPosition === "number"
          ) {
            setPosition(event.currentPosition);
          }
        });
        return true;
      } catch (_) {
        scWidget = null;
        return false;
      }
    })();

    const ok = await widgetLoading;
    widgetLoading = null;
    return ok;
  }

  wireNativeEvents();

  /* =========================================================
     Search
     ========================================================= */

  let searchTimer = 0;
  let searchController = null;
  let searchToken = 0;

  const compactText = (value) =>
    String(value)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");

  const filterTracks = (query) => {
    const needle = compactText(query);
    if (!needle) return feed;
    return feed.filter((track) =>
      compactText(
        `${track.title} ${track.artist} ${track.album || ""} ${track.genre || ""}`
      ).includes(needle)
    );
  };

  function createResultRow(track, queue) {
    const row = el("button", "result");
    row.type = "button";
    row.dataset.id = track.id;
    row.setAttribute("aria-label", `Включить ${track.title}`);

    const cover = el("img", "result__cover");
    cover.src = track.cover || FALLBACK_COVER;
    cover.alt = "";
    cover.loading = "lazy";
    guardCover(cover);

    const text = el("span", "result__text");
    text.appendChild(el("span", "result__title", track.title));
    text.appendChild(
      el(
        "span",
        "result__meta",
        [track.artist, track.album, track.genre].filter(Boolean).join(" · ") ||
          library.source.name
      )
    );

    const duration = el("span", "result__dur", formatTime(track.duration));

    const play = el("span", "result__play");
    play.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 4.8 20 12 8 19.2V4.8Z" fill="currentColor"/></svg>';

    row.append(cover, text, duration, play);
    row.addEventListener("click", () => {
      if (state.view === "search") learnFromQuery(dom.searchInput.value);
      playTrack(track, queue);
    });
    return row;
  }

  function markCurrentRow() {
    if (!state.current) return;
    $$(".result", dom.results).forEach((row) => {
      row.classList.toggle("is-current", row.dataset.id === state.current.id);
    });
    $$(".artist-track", dom.artistTracks).forEach((row) => {
      row.classList.toggle("is-current", row.dataset.trackId === state.current.id);
    });
  }

  function paintNotice(caption) {
    dom.results.innerHTML = "";
    dom.results.appendChild(el("p", "results__caption", caption));
  }

  function paintResults(list, caption) {
    dom.results.innerHTML = "";

    dom.results.appendChild(el("p", "results__caption", caption));

    if (!list.length) {
      const empty = el("div", "empty");
      empty.appendChild(el("strong", "", "ничего не нашлось."));
      empty.appendChild(document.createTextNode("попробуйте другое слово, жанр или исполнителя."));
      dom.results.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    list.forEach((track) => fragment.appendChild(createResultRow(track, list)));
    dom.results.appendChild(fragment);
    markCurrentRow();
  }

  function cancelSearch() {
    window.clearTimeout(searchTimer);
    if (searchController) {
      searchController.abort();
      searchController = null;
    }
    searchToken += 1;
  }

  function scheduleSearch(query, local) {
    const token = ++searchToken;
    window.clearTimeout(searchTimer);
    if (searchController) searchController.abort();

    searchTimer = window.setTimeout(async () => {
      const controller = new AbortController();
      searchController = controller;
      try {
        const remote = await searchSoundCloud(query, 30, controller.signal);
        if (token !== searchToken || dom.searchInput.value.trim() !== query) return;

        const merged = dedupe([...local, ...remote]);
        paintResults(merged, `найдено · ${merged.length}`);
      } catch (error) {
        if (error.name === "AbortError" || token !== searchToken) return;
        const fallback = local.length ? local : filterTracks(query);
        paintResults(
          fallback,
          fallback.length ? `найдено · ${fallback.length}` : "ничего не нашлось · проверьте соединение"
        );
      } finally {
        if (searchController === controller) searchController = null;
      }
    }, 260);
  }

  function renderResults(query = dom.searchInput.value) {
    const normalized = query.trim();

    if (!normalized) {
      cancelSearch();
      if (feed.length) {
        paintResults(feed, `тренды · ${feed.length}`);
      } else {
        paintNotice(
          feedError ? "не удалось загрузить тренды · попробуйте поиск" : "загружаем тренды…"
        );
      }
      return;
    }

    const local = filterTracks(normalized);
    paintResults(local, local.length ? `найдено · ${local.length}` : "ищем…");
    scheduleSearch(normalized, local);
  }

  dom.searchInput.addEventListener("input", () => renderResults(dom.searchInput.value));

  dom.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const query = dom.searchInput.value.trim();
      if (query.length >= 2) {
        event.preventDefault();
        learnFromQuery(query);
      }
      return;
    }
    if (event.key === "Escape" && dom.searchInput.value) {
      event.stopPropagation();
      dom.searchInput.value = "";
      renderResults();
    }
  });

  /* =========================================================
     Artists
     ========================================================= */

  // Кириллица и латиница в никах часто перемешаны
  // («Cкриптoнит»), поэтому перед сравнением приводим похожие буквы
  // к одному виду.
  const HOMOGLYPHS = {
    а: "a",
    в: "b",
    е: "e",
    к: "k",
    м: "m",
    н: "h",
    о: "o",
    р: "p",
    с: "c",
    т: "t",
    у: "y",
    х: "x",
    і: "i",
    ј: "j",
    ѕ: "s",
  };

  const foldText = (value) =>
    String(value || "").replace(/[авекмнорстухіјѕ]/g, (char) => HOMOGLYPHS[char] || char);

  const normText = (value) =>
    foldText(decodeEntities(String(value || "")).toLowerCase().replace(/ё/g, "е"))
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  const normCompact = (value) => normText(value).replace(/\s+/g, "");

  const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const artistAliases = (artist) =>
    [artist.name, ...(Array.isArray(artist.aliases) ? artist.aliases : [])].filter(Boolean);

  const artistNeedles = (artist) =>
    artistAliases(artist)
      .map(normCompact)
      .filter((needle) => needle.length >= 2);

  // Длинные имена ищем где угодно («feat. Скриптонит»), короткие —
  // только в начале названия, иначе «Кино» ловит «хочу сходить в кино».
  const artistPatterns = (artist) =>
    artistAliases(artist)
      .map((alias) => {
        const normalized = normText(alias);
        const words = normalized.split(" ").filter(Boolean).map(escapeRe);
        if (!words.length) return null;
        const sequence = words.join("[\\s\\-–—_.]*");
        const compact = normalized.replace(/\s+/g, "");
        const left =
          compact.length <= 5 ? "^[\\s\\-–—|:•·(\\[«\"]*" : "(?<![\\p{L}\\p{N}])";
        return new RegExp(`${left}(?:${sequence})(?![\\p{L}\\p{N}])`, "iu");
      })
      .filter(Boolean);

  const JUNK_UPLOAD =
    /\b(speed ?up|sped ?up|slowed|reverb|nightcore|8d|bass ?boost(?:ed)?|tik ?tok|trending|flip)\b|#[\p{L}\p{N}_]{4,}|\.(?:mp3|wav|m4a|flac)\b/iu;

  const ARTIST_TRACKS_MAX = 150;
  const ARTIST_PAGES_MAX = 3;
  const ARTIST_CACHE_TTL = 6 * 60 * 60 * 1000;

  const byPlays = (list) =>
    [...list].sort((a, b) => (Number(b.plays) || 0) - (Number(a.plays) || 0));

  // Один и тот же трек часто перезалит десятком аккаунтов — оставляем
  // самый популярный вариант.
  function artistUnique(list) {
    const ids = new Set();
    const titles = new Set();
    const result = [];

    list.forEach((track) => {
      if (!track || !track.id || ids.has(track.id)) return;
      const key = normCompact(track.title);
      if (titles.has(key)) return;
      ids.add(track.id);
      titles.add(key);
      result.push(track);
    });

    return result;
  }

  function withClientId(href) {
    if (!href) return "";
    if (/[?&]client_id=/.test(href)) return href;
    return `${href}${href.includes("?") ? "&" : "?"}client_id=${SC_CONFIG.clientId}`;
  }

  async function fetchArtistTracks(artist, { signal } = {}) {
    const needles = artistNeedles(artist);
    const patterns = artistPatterns(artist);
    const found = [];
    const official = new Set();

    const collect = (items) => {
      items.forEach((item) => {
        const track = fromSoundCloud(item);
        if (!track || JUNK_UPLOAD.test(track.title)) return;

        const user = normCompact(track.artist);
        const title = foldText(track.title).toLowerCase();
        const userHit = needles.some((needle) => user.includes(needle));
        const titleHit = patterns.some((pattern) => pattern.test(title));

        // Совпадение только по названию — это чаще перезалив. Совсем
        // непопулярные записи отсеиваем, чтобы в конце списка не было мусора.
        if (!userHit && (!titleHit || (track.plays || 0) < 1000)) return;

        if (userHit) official.add(track.id);
        found.push(track);
      });
    };

    let url = scUrl("/search/tracks", {
      q: artist.query || artist.name,
      limit: "50",
      linked_partitioning: "1",
    });

    for (let page = 0; page < ARTIST_PAGES_MAX && url; page += 1) {
      const json = await requestJson(url, signal);
      collect(Array.isArray(json.collection) ? json.collection : []);

      if (artistUnique(byPlays(found)).length >= 45) break;
      url = typeof json.next_href === "string" ? withClientId(json.next_href) : "";
    }

    // Сначала треки с аккаунта самого артиста, потом перезаливы по
    // популярности.
    return artistUnique(byPlays(found))
      .sort(
        (a, b) =>
          (official.has(b.id) ? 1 : 0) - (official.has(a.id) ? 1 : 0)
      )
      .slice(0, ARTIST_TRACKS_MAX);
  }

  const artistCache = new Map();

  const artistStorageKey = (name) => `${STORE.artist}:${encodeURIComponent(name)}`;

  function readArtistCache(name) {
    if (artistCache.has(name)) return artistCache.get(name);

    try {
      const raw = JSON.parse(localStorage.getItem(artistStorageKey(name)) || "null");
      if (!raw || Date.now() - (Number(raw.at) || 0) > ARTIST_CACHE_TTL) return null;
      const tracks = Array.isArray(raw.tracks) ? raw.tracks.filter(isCachedTrack) : [];
      if (!tracks.length) return null;
      artistCache.set(name, tracks);
      return tracks;
    } catch (_) {
      return null;
    }
  }

  function writeArtistCache(name, tracks) {
    artistCache.set(name, tracks);
    try {
      localStorage.setItem(
        artistStorageKey(name),
        JSON.stringify({ at: Date.now(), tracks })
      );
    } catch (_) {
      /* ignore quota errors */
    }
  }

  function artistInitials(name) {
    const words = String(name).split(/[\s.\-–—]+/).filter(Boolean);
    if (!words.length) return "?";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }

  function artistGradient(name) {
    let hash = 0;
    for (const char of String(name)) {
      hash = (hash * 31 + char.codePointAt(0)) % 360;
    }
    return `linear-gradient(152deg, hsl(${hash} 24% 24%), hsl(${(hash + 68) % 360} 32% 10%) 74%)`;
  }

  const artistPlayIcon =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 4.8 20 12 8 19.2V4.8Z" fill="currentColor"/></svg>';

  function createArtistCard(artist) {
    const card = el("button", "artist-card");
    card.type = "button";
    card.setAttribute("aria-label", `Открыть ${artist.name}`);

    const face = el("span", "artist-card__face");
    face.style.background = artistGradient(artist.name);
    face.appendChild(el("span", "artist-card__initials", artistInitials(artist.name)));

    const overlay = el("span", "artist-card__overlay");
    const play = el("span", "artist-card__play");
    play.innerHTML = artistPlayIcon;
    overlay.appendChild(play);
    face.appendChild(overlay);

    card.append(
      face,
      el("span", "artist-card__name", artist.name),
      el("span", "artist-card__meta", artist.tag || "исполнитель")
    );

    card.addEventListener("click", () => openArtist(artist));
    return card;
  }

  function renderArtists() {
    if (!dom.artists) return;
    dom.artists.innerHTML = "";

    if (!ARTISTS.length) {
      dom.artists.appendChild(el("p", "artist-status", "список исполнителей пуст"));
      return;
    }

    const fragment = document.createDocumentFragment();
    ARTISTS.forEach((artist) => fragment.appendChild(createArtistCard(artist)));
    dom.artists.appendChild(fragment);
  }

  let activeArtistTracks = [];
  let artistToken = 0;
  let artistController = null;

  function shuffleList(list) {
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const random = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[random]] = [copy[random], copy[index]];
    }
    return copy;
  }

  function createArtistRow(track, list, index) {
    const row = el("button", "artist-track");
    row.type = "button";
    row.dataset.trackId = track.id;
    row.setAttribute("aria-label", `Включить ${track.title}`);

    const cover = el("img", "artist-track__cover");
    cover.src = track.cover || FALLBACK_COVER;
    cover.alt = "";
    cover.loading = "lazy";
    guardCover(cover);

    const text = el("span", "artist-track__text");
    text.append(
      el("span", "artist-track__name", track.title),
      el("span", "artist-track__meta", track.artist)
    );

    const play = el("span", "artist-track__play");
    play.innerHTML = artistPlayIcon;

    row.append(
      el("span", "artist-track__no", String(index + 1).padStart(2, "0")),
      cover,
      text,
      el("span", "artist-track__dur", formatTime(track.duration)),
      play
    );

    if (state.current && state.current.id === track.id) {
      row.classList.add("is-current");
    }

    row.addEventListener("click", () => startQueue(list, index));
    return row;
  }

  function paintArtistTracks(tracks) {
    dom.artistTracks.innerHTML = "";

    if (!tracks.length) {
      dom.artistTracks.appendChild(
        el("p", "artist-status", "подходящих треков не нашлось")
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    tracks.forEach((track, index) =>
      fragment.appendChild(createArtistRow(track, tracks, index))
    );
    dom.artistTracks.appendChild(fragment);
  }

  function showArtistTracks(artist, tracks) {
    activeArtistTracks = tracks;
    const meta = [
      artist.tag,
      `${tracks.length} ${tracksWord(tracks.length)}`,
    ].filter(Boolean);
    dom.artistMeta.textContent = meta.join(" · ");
    dom.artistPlay.disabled = false;
    dom.artistShuffle.disabled = tracks.length < 2;
    paintArtistTracks(tracks);
  }

  function artistError(artist) {
    dom.artistMeta.textContent = artist.tag
      ? `${artist.tag} · не удалось загрузить`
      : "не удалось загрузить";
    dom.artistTracks.innerHTML = "";

    const box = el("div", "empty");
    box.append(
      el("strong", "", "нет соединения."),
      document.createTextNode("источник не ответил — попробуйте ещё раз.")
    );

    const retry = el("button", "ghost-pill", "Повторить");
    retry.type = "button";
    retry.addEventListener("click", () => openArtist(artist, { force: true }));
    box.appendChild(retry);

    dom.artistTracks.appendChild(box);
  }

  async function openArtist(artist, { force = false } = {}) {
    if (!artist) return;

    activeArtistTracks = [];
    artistToken += 1;
    const token = artistToken;
    if (artistController) artistController.abort();

    setView("artist");
    dom.artistPageTitle.textContent = artist.name;
    dom.artistPageTitle.classList.toggle("is-long", artist.name.length > 16);
    dom.artistMeta.textContent = artist.tag
      ? `${artist.tag} · загружаем треки…`
      : "загружаем треки…";
    dom.artistPlay.disabled = true;
    dom.artistShuffle.disabled = true;
    dom.artistTracks.innerHTML = "";

    const cached = force ? null : readArtistCache(artist.name);
    if (cached) {
      showArtistTracks(artist, cached);
      return;
    }

    dom.artistTracks.appendChild(
      el("p", "artist-status", "загружаем треки…")
    );

    const controller = new AbortController();
    artistController = controller;

    try {
      const tracks = await fetchArtistTracks(artist, { signal: controller.signal });
      if (token !== artistToken) return;

      if (!tracks.length) {
        dom.artistMeta.textContent = artist.tag
          ? `${artist.tag} · ничего не найдено`
          : "ничего не найдено";
        paintArtistTracks([]);
        return;
      }

      writeArtistCache(artist.name, tracks);
      showArtistTracks(artist, tracks);
    } catch (error) {
      if (error.name === "AbortError" || token !== artistToken) return;
      artistError(artist);
    } finally {
      if (artistController === controller) artistController = null;
    }
  }

  dom.artistBack.addEventListener("click", () => {
    setView("artists");
  });

  dom.artistPlay.addEventListener("click", () => {
    if (activeArtistTracks.length) startQueue(activeArtistTracks, 0);
  });

  dom.artistShuffle.addEventListener("click", () => {
    if (activeArtistTracks.length) {
      startQueue(shuffleList(activeArtistTracks), 0);
    }
  });

  /* =========================================================
     Playlists
     ========================================================= */

  function persistUserPlaylists() {
    try {
      localStorage.setItem(STORE.playlists, JSON.stringify(userPlaylists));
    } catch (_) {
      /* ignore */
    }
  }

  function createPlaylist(title, track = null) {
    const playlist = {
      id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      title,
      createdAt: Date.now(),
      tracks: track ? [track] : [],
    };
    userPlaylists.unshift(playlist);
    persistUserPlaylists();
    return playlist;
  }

  function addTrackToPlaylist(playlist, track) {
    if (playlist.tracks.some((item) => item.id === track.id)) return false;
    playlist.tracks.push(track);
    persistUserPlaylists();
    return true;
  }

  function removeTrackFromPlaylist(playlist, trackId) {
    const next = playlist.tracks.filter((track) => track.id !== trackId);
    if (next.length === playlist.tracks.length) return false;
    playlist.tracks = next;
    persistUserPlaylists();
    return true;
  }

  let dialogReturnFocus = null;
  let dialogCleanup = null;

  function showDialog(title, nodes, cleanup = null) {
    if (dialogCleanup) dialogCleanup();
    dialogCleanup = cleanup;
    dom.dialogTitle.textContent = title;
    dom.dialogBody.innerHTML = "";
    nodes.forEach((node) => dom.dialogBody.appendChild(node));
    dom.playlistDialog.hidden = false;
    dialogReturnFocus = document.activeElement;
  }

  function closeDialog() {
    if (dom.playlistDialog.hidden) return;
    dom.playlistDialog.hidden = true;
    dom.dialogBody.innerHTML = "";
    if (dialogCleanup) {
      dialogCleanup();
      dialogCleanup = null;
    }
    if (dialogReturnFocus && typeof dialogReturnFocus.focus === "function") {
      dialogReturnFocus.focus({ preventScroll: true });
    }
    dialogReturnFocus = null;
  }

  dom.playlistDialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-dialog]")) closeDialog();
  });

  function appDirectory() {
    try {
      const path = decodeURIComponent(window.location.pathname || "").replace(/^\/+/, "");
      const dir = path.replace(/\/[^/]+$/, "");
      return (dir || "C:\\Users\\Admin\\kokky").replace(/\//g, "\\");
    } catch (_) {
      return "C:\\Users\\Admin\\kokky";
    }
  }

  function openServerHelp() {
    const panel = el("div", "dialog__help");

    panel.appendChild(
      el(
        "p",
        "dialog__hint",
        "Браузер не даёт плееру работать со страницы file://. Запустите kokky через локальный сервер — и всё заработает."
      )
    );

    const steps = el("ol", "dialog__steps");
    steps.append(
      el("li", "", "Дважды кликните start.bat в папке kokky."),
      el("li", "", "Откроется http://localhost:8000 — играйте и добавляйте треки.")
    );
    panel.appendChild(steps);

    const command = `cd ${appDirectory()}\npython -m http.server 8000`;
    panel.appendChild(el("pre", "dialog__code", command));

    const actions = el("div", "dialog__actions");

    const copy = el("button", "ghost-pill", "Скопировать команду");
    copy.type = "button";
    copy.addEventListener("click", () => {
      copyText(command).then((ok) => {
        toast(ok ? "команда скопирована" : "не удалось скопировать");
      });
    });

    const done = el("button", "solid-pill", "Понятно");
    done.type = "button";
    done.addEventListener("click", closeDialog);

    actions.append(copy, done);
    panel.appendChild(actions);

    showDialog("как запустить", [panel]);
  }

  dom.serverHelpBtn.addEventListener("click", openServerHelp);

  function openCreateDialog(pendingTrack = null) {
    const form = el("form", "dialog__form");

    const input = el("input", "dialog__input");
    input.type = "text";
    input.maxLength = 60;
    input.placeholder = "название плейлиста";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Название плейлиста");

    const actions = el("div", "dialog__actions");
    const cancel = el("button", "ghost-pill", "Отмена");
    cancel.type = "button";
    cancel.addEventListener("click", closeDialog);

    const submit = el("button", "solid-pill", "Создать");
    submit.type = "submit";
    actions.append(cancel, submit);

    form.append(input, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = input.value.trim();
      if (!title) {
        input.focus();
        return;
      }
      const playlist = createPlaylist(title, pendingTrack);
      closeDialog();
      renderPlaylists();
      openPlaylist(playlist.id);
      toast(
        pendingTrack
          ? `плейлист «${playlist.title}» создан · трек добавлен`
          : `плейлист «${playlist.title}» создан · добавьте треки`
      );
    });

    showDialog("новый плейлист", [form]);
    window.setTimeout(() => input.focus({ preventScroll: true }), 40);
  }

  function openAddToPlaylist() {
    const track = state.current;
    if (!track) {
      toast("сначала включите трек");
      return;
    }

    if (!userPlaylists.length) {
      openCreateDialog(track);
      return;
    }

    const list = el("div", "dialog__choices");

    userPlaylists.forEach((playlist) => {
      const choice = el("button", "dialog__choice");
      choice.type = "button";
      choice.append(
        el("span", "dialog__choice-name", playlist.title),
        el(
          "span",
          "dialog__choice-meta",
          `${playlist.tracks.length} ${tracksWord(playlist.tracks.length)}`
        )
      );
      choice.addEventListener("click", () => {
        const added = addTrackToPlaylist(playlist, track);
        closeDialog();
        renderPlaylists();
        if (activePlaylistId === playlist.id) renderPlaylistDetail();
        toast(added ? `добавлено в «${playlist.title}»` : `уже есть в «${playlist.title}»`);
      });
      list.appendChild(choice);
    });

    const create = el("button", "dialog__new", "+ новый плейлист");
    create.type = "button";
    create.addEventListener("click", () => openCreateDialog(track));
    list.appendChild(create);

    showDialog("добавить в плейлист", [list]);
  }

  function openAddTracksDialog(playlist) {
    const panel = el("div", "dialog__search");

    const input = el("input", "dialog__input");
    input.type = "search";
    input.placeholder = "найти трек";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Поиск трека");

    const hint = el(
      "p",
      "dialog__hint",
      "выберите трек — он сразу появится в плейлисте"
    );

    const list = el("div", "dialog__tracks");
    panel.append(input, hint, list);

    const paint = (tracks, caption) => {
      list.innerHTML = "";
      if (caption) list.appendChild(el("p", "dialog__caption", caption));
      if (!tracks.length) return;

      tracks.forEach((track) => {
        const already = playlist.tracks.some((item) => item.id === track.id);
        const row = el("button", already ? "dialog__track is-added" : "dialog__track");
        row.type = "button";
        row.setAttribute("aria-label", `Добавить ${track.title}`);

        const cover = el("img", "dialog__track-cover");
        cover.src = track.cover || FALLBACK_COVER;
        cover.alt = "";
        cover.loading = "lazy";
        guardCover(cover);

        const text = el("span", "dialog__track-text");
        text.append(
          el("span", "dialog__track-name", track.title),
          el("span", "dialog__track-meta", track.artist)
        );

        const action = el("span", "dialog__track-action", already ? "✓" : "+");

        row.append(
          cover,
          text,
          el("span", "dialog__track-dur", formatTime(track.duration)),
          action
        );

        row.addEventListener("click", () => {
          if (!addTrackToPlaylist(playlist, track)) {
            toast(`уже есть в «${playlist.title}»`);
            return;
          }
          row.classList.add("is-added");
          action.textContent = "✓";
          renderPlaylistDetail();
          renderPlaylists();
          toast(`«${track.title}» добавлен в плейлист`);
        });

        list.appendChild(row);
      });
    };

    paint(feed.slice(0, 30), feed.length ? "тренды" : "начните вводить название");

    let timer = 0;
    let controller = null;
    let token = 0;

    const runSearch = async (query, currentToken) => {
      controller = new AbortController();
      try {
        const remote = await searchSoundCloud(query, 24, controller.signal);
        if (currentToken !== token) return;
        const merged = dedupe([...filterTracks(query), ...remote]);
        paint(merged, `найдено · ${merged.length}`);
      } catch (error) {
        if (error.name === "AbortError" || currentToken !== token) return;
        const local = filterTracks(query);
        paint(local, local.length ? `найдено · ${local.length}` : "ничего не нашлось");
      }
    };

    input.addEventListener("input", () => {
      window.clearTimeout(timer);
      if (controller) controller.abort();
      token += 1;
      const query = input.value.trim();

      if (!query) {
        paint(feed.slice(0, 30), feed.length ? "тренды" : "начните вводить название");
        return;
      }

      const currentToken = token;
      timer = window.setTimeout(() => runSearch(query, currentToken), 280);
    });

    showDialog(`добавить в «${playlist.title}»`, [panel], () => {
      window.clearTimeout(timer);
      token += 1;
      if (controller) controller.abort();
    });

    window.setTimeout(() => input.focus({ preventScroll: true }), 40);
  }

  const openIcon =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9.8 6.6 5.4 5.4-5.4 5.4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const removeIcon =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6.8 6.8 10.4 10.4M17.2 6.8 6.8 17.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  function createCreateCard() {
    const card = el("button", "playlist-create");
    card.type = "button";
    card.setAttribute("aria-label", "Создать плейлист");

    const mark = el("span", "playlist-create__mark");
    mark.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5.2v13.6M5.2 12h13.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

    card.append(mark, el("span", "playlist-create__label", "создать плейлист"));
    card.addEventListener("click", () => openCreateDialog());
    return card;
  }

  function createUserCard(playlist) {
    const card = el("button", "playlist");
    card.type = "button";
    card.setAttribute("aria-label", `Открыть плейлист «${playlist.title}»`);

    const wrap = el("span", "playlist__cover-wrap");

    if (playlist.tracks.length) {
      const cover = el("img", "playlist__cover");
      cover.src = playlist.tracks[0].cover || FALLBACK_COVER;
      cover.alt = `Плейлист «${playlist.title}»`;
      cover.loading = "lazy";
      guardCover(cover);
      wrap.appendChild(cover);
    } else {
      const empty = el("span", "playlist__empty");
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6.5h9.5M4 11.5h9.5M4 16.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16.5 7.2v8.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="18.7" cy="16.6" r="2.2" fill="currentColor"/><path d="M18.7 16.6V7.8l2.2-.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      wrap.appendChild(empty);
    }

    const overlay = el("span", "playlist__overlay");
    const open = el("span", "playlist__play");
    open.innerHTML = openIcon;
    overlay.appendChild(open);
    wrap.appendChild(overlay);

    card.append(
      wrap,
      el("span", "playlist__name", playlist.title),
      el(
        "span",
        "playlist__meta",
        `${playlist.tracks.length} ${tracksWord(playlist.tracks.length)} · мой плейлист`
      )
    );
    card.addEventListener("click", () => openPlaylist(playlist.id));
    return card;
  }

  function renderPlaylists() {
    dom.playlists.innerHTML = "";
    dom.playlists.appendChild(createCreateCard());
    userPlaylists.forEach((playlist) => dom.playlists.appendChild(createUserCard(playlist)));
  }

  let activePlaylistId = null;

  function getActivePlaylist() {
    return userPlaylists.find((playlist) => playlist.id === activePlaylistId) || null;
  }

  function openPlaylist(id) {
    const playlist = userPlaylists.find((item) => item.id === id);
    if (!playlist) return;
    activePlaylistId = id;
    setView("playlist");
    renderPlaylistDetail();
  }

  function renderPlaylistDetail() {
    const playlist = getActivePlaylist();
    if (!playlist) {
      setView("playlists");
      renderPlaylists();
      return;
    }

    const count = playlist.tracks.length;
    dom.playlistTitle.textContent = playlist.title;
    dom.playlistMeta.textContent = `${count} ${tracksWord(count)} · мой плейлист`;
    dom.playlistPlay.disabled = count === 0;
    dom.playlistTracks.innerHTML = "";

    if (!count) {
      const empty = el("div", "pl-empty");
      empty.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6.5h9.5M4 11.5h9.5M4 16.5h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M16.5 7.2v8.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="18.6" cy="16.6" r="2.1" fill="currentColor"/><path d="M18.6 16.6V7.8l2.2-.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      const text = el("div", "pl-empty__text");
      text.append(
        el("strong", "", "пока пусто"),
        el("p", "", "добавьте первый трек — поиск идёт по всему каталогу.")
      );

      const add = el("button", "ghost-pill", "Добавить трек");
      add.type = "button";
      add.addEventListener("click", () => openAddTracksDialog(playlist));

      empty.append(text, add);
      dom.playlistTracks.appendChild(empty);
      return;
    }

    playlist.tracks.forEach((track, index) => {
      const row = el("div", "pl-track");

      const main = el("button", "pl-track__main");
      main.type = "button";
      main.setAttribute("aria-label", `Включить ${track.title}`);

      const cover = el("img", "pl-track__cover");
      cover.src = track.cover || FALLBACK_COVER;
      cover.alt = "";
      cover.loading = "lazy";
      guardCover(cover);

      const text = el("span", "pl-track__text");
      text.append(
        el("span", "pl-track__name", track.title),
        el("span", "pl-track__artist", track.artist || library.source.name)
      );

      main.append(
        cover,
        text,
        el("span", "pl-track__dur", formatTime(track.duration))
      );
      main.addEventListener("click", () => playUserPlaylist(playlist, index));

      const remove = el("button", "pl-track__remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Убрать ${track.title} из плейлиста`);
      remove.innerHTML = removeIcon;
      remove.addEventListener("click", () => {
        if (!removeTrackFromPlaylist(playlist, track.id)) return;
        renderPlaylistDetail();
        renderPlaylists();
        toast("трек убран из плейлиста");
      });

      row.append(main, remove);
      dom.playlistTracks.appendChild(row);
    });
  }

  dom.playlistBack.addEventListener("click", () => {
    setView("playlists");
    renderPlaylists();
  });

  dom.playlistPlay.addEventListener("click", () => {
    const playlist = getActivePlaylist();
    if (playlist) playUserPlaylist(playlist);
  });

  dom.playlistAdd.addEventListener("click", () => {
    const playlist = getActivePlaylist();
    if (playlist) openAddTracksDialog(playlist);
  });

  dom.playlistBtn.addEventListener("click", openAddToPlaylist);

  /* =========================================================
     Navigation
     ========================================================= */

  function setView(view) {
    if (!dom.views[view]) return;
    state.view = view;
    const navView =
      view === "playlist" ? "playlists" : view === "artist" ? "artists" : view;

    dom.navItems.forEach((item) => {
      item.classList.toggle("is-active", item.dataset.view === navView);
    });

    Object.entries(dom.views).forEach(([name, node]) => {
      node.hidden = name !== view;
    });

    dom.stage.classList.toggle("is-browsing", view !== "stream");
    if (view !== "stream") {
      dom.stage.classList.remove("is-idle");
    } else {
      dom.stage.classList.toggle("is-idle", state.closed);
    }

    if (view === "search") {
      renderResults(dom.searchInput.value);
      if (window.matchMedia("(min-width: 821px)").matches) {
        window.setTimeout(() => dom.searchInput.focus({ preventScroll: true }), 60);
      }
    } else {
      cancelSearch();
    }

    if (view === "artists") {
      renderArtists();
    }

    // Ушли из карточки исполнителя — отменяем незавершённую загрузку.
    if (view !== "artist") {
      artistToken += 1;
      if (artistController) {
        artistController.abort();
        artistController = null;
      }
    }

    closeMenus();
  }

  dom.navItems.forEach((item) => {
    item.addEventListener("click", () => setView(item.dataset.view));
  });

  $(".brand").addEventListener("click", (event) => {
    event.preventDefault();
    setView("stream");
  });

  /* =========================================================
     Keyboard
     ========================================================= */

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof Element && target.closest("input, textarea, [contenteditable]");

    if (typing) return;

    if (event.key === "Escape") {
      closeMenus();
      return;
    }

    if (target instanceof Element && target.closest('button, a, [role="slider"], iframe')) {
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
      togglePlay();
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      seekToRatio((getCurrentTime() + 5) / getDuration());
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekToRatio((getCurrentTime() - 5) / getDuration());
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.volume = Math.min(1, state.volume + 0.05);
      state.muted = false;
      applyVolume(true);
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.volume = Math.max(0, state.volume - 0.05);
      applyVolume(true);
    }

    if (event.key === "/") {
      event.preventDefault();
      setView("search");
    }
  });

  /* =========================================================
     Media Session
     ========================================================= */

  let mediaSessionReady = false;

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", () => playAudio());
      navigator.mediaSession.setActionHandler("pause", () => pauseAudio());
      navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
      navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
      navigator.mediaSession.setActionHandler("seekbackward", () =>
        seekToRatio((getCurrentTime() - 5) / getDuration())
      );
      navigator.mediaSession.setActionHandler("seekforward", () =>
        seekToRatio((getCurrentTime() + 5) / getDuration())
      );
      mediaSessionReady = true;
    } catch (_) {
      mediaSessionReady = false;
    }
  }

  function updateMediaSession(track) {
    if (!mediaSessionReady || typeof MediaMetadata === "undefined") return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album || library.source.name,
        artwork: [
          {
            src: new URL(track.cover || FALLBACK_COVER, window.location.href).href,
            sizes: "480x480",
            type: "image/jpeg",
          },
        ],
      });
    } catch (_) {
      /* ignore */
    }
  }

  /* =========================================================
     Motion preference
     ========================================================= */

  function syncMotionUI() {
    const reduced = dom.body.classList.contains("reduce-motion");
    dom.settingsItemMotion?.classList.toggle("is-on", reduced);
    dom.motionCheck?.setAttribute("aria-hidden", reduced ? "false" : "true");
  }

  try {
    if (localStorage.getItem(STORE.motion) === "1") {
      dom.body.classList.add("reduce-motion");
    }
  } catch (_) {
    /* ignore */
  }
  syncMotionUI();

  /* =========================================================
     Initial paint
     ========================================================= */

  let feedInFlight = false;
  let feedRefreshTimer = 0;
  let feedRefreshQueued = false;
  let lastFeedRefreshAt = 0;
  const FEED_REFRESH_INTERVAL = 90000;

  function adoptFeed(list) {
    feed = dedupe(list);
    feedError = false;

    if (feed.length) {
      if (!state.current || !state.started) {
        state.current = feed[0];
        updateTrackUI(feed[0]);
      }
      if (!state.started) {
        state.queue = feed;
        state.index = Math.max(
          0,
          feed.findIndex((track) => track.id === state.current.id)
        );
      }
    }

    if (!dom.searchInput.value.trim()) {
      renderResults();
    }
  }

  function loadCachedFeed() {
    const cached = readFeedCache();
    if (!cached.tracks.length) return;
    adoptFeed(cached.tracks);
  }

  function scheduleFeedRefresh() {
    if (feedInFlight) {
      feedRefreshQueued = true;
      return;
    }
    window.clearTimeout(feedRefreshTimer);
    const wait = Math.max(
      2600,
      FEED_REFRESH_INTERVAL - (Date.now() - lastFeedRefreshAt)
    );
    feedRefreshTimer = window.setTimeout(() => {
      feedRefreshTimer = 0;
      lastFeedRefreshAt = Date.now();
      loadFeed();
    }, wait);
  }

  async function loadFeed() {
    if (feedInFlight) {
      feedRefreshQueued = true;
      return;
    }
    feedInFlight = true;
    window.clearTimeout(feedRefreshTimer);
    feedRefreshTimer = 0;

    try {
      const list = await fetchFeed();
      if (!list.length) throw new Error("empty feed");

      writeFeedCache(list);
      adoptFeed(list);
    } catch (_) {
      feedError = feed.length === 0;
      if (state.view === "search" && !dom.searchInput.value.trim()) {
        renderResults();
      }
      if (!state.current) {
        dom.trackTitle.textContent = "нет соединения";
        toast("не удалось загрузить тренды · проверьте соединение");
      }
    } finally {
      feedInFlight = false;
      if (feedRefreshQueued) {
        feedRefreshQueued = false;
        scheduleFeedRefresh();
      }
    }
  }

  function init() {
    renderPlaylists();
    renderArtists();
    applyVolume();
    setupMediaSession();
    syncWelcome();
    loadCachedFeed();
    syncPlayState();
    setView("stream");
    renderResults();

    if (FILE_MODE) {
      dom.artNotice.hidden = false;
    }

    loadFeed();
  }

  init();
})();
