/**
 * DouyinMini × Hongguo Glasses Engine
 *
 * - Viewport locked to 480x380 physical px (640x507 CSS px @ dpr=0.75).
 * - Initial entry strictly loads 2 recommended feed videos (1 / 2); swiping down loads 2 more at a time.
 * - Browse grid page removed; only vertical (forward/back) video switching is allowed.
 * - Video sources prefer AVC up to 1080p, with lower resolutions kept as fallbacks.
 * - Double-click in player prompts "再次双击退出抖音", second double-click within 2.5s exits app.
 * - Right-side long-press command menu includes 自动连播 (Auto-Next) toggle and System Volume controls.
 */
(function () {
  'use strict';

  // Never mount the shell or issue relative API requests on WebView error pages.
  if (location.protocol !== 'https:' || !/(^|\.)douyin\.com$/.test(location.hostname)) return;

  var w = window;
  var d = document;

  if (w.__HG_DOUYIN_ENGINE__) {
    w.__HG_DOUYIN_ENGINE__.ensureMounted();
    return;
  }

  var SPEEDS = [1.0, 1.25, 1.5, 2.0, 0.75];
  var TARGET_RESOLUTION = 1080;
  var MAX_VIDEO_SHORT_EDGE = 1080;
  var INITIAL_QUEUE_CAP = 2;
  var BATCH_LOAD_COUNT = 2;
  var TOP_PEEK_MS = 2600;
  var EXIT_CONFIRM_WINDOW_MS = 2500;
  var MAX_HISTORY = 45;
  var MAX_FAVORITES = 60;
  var VIDEO_STALL_TIMEOUT_MS = 20000;
  var videoStallTimer = null;
  var qualityProfileEnabled = isGimbalQualityEnhanced();
  var qualitySwitchVersion = 0;
  var qualityResume = null;

  var state = {
    view: 'player',         // 'player' | 'login' | 'native'
    menuOpen: false,
    bottomOpen: false,
    bottomFocusIdx: 0,
    bottomMode: "main",
    commentRows: [],
    commentStatus: "",
    commentRequest: 0,
    likedIds: {},
    likePending: false,
    autoPlayNext: true,
    speedIndex: 0,
    muted: false,
    volumePct: 70,
    activeQualityLabel: '540P',

    maxAllowedQueue: INITIAL_QUEUE_CAP,
    queue: [],              // Array<VideoItem> active in player queue
    queueMap: {},           // id -> VideoItem
    pendingPool: [],        // Extra normalized items held in reserve (unlocked 2 at a time on swipe)
    pendingMap: {},         // id -> VideoItem in reserve
    currentIndex: -1,
    currentUrlIndex: 0,
    preloadedUrl: '',

    history: [],            // Array<VideoItem>
    favorites: [],          // Array<VideoItem>
    progressMap: {},        // id -> seconds

    menuFocusIdx: 0,
    loginFocusIdx: 0,
    qrFullscreen: false,
    nativeFocusIdx: -1,
    nativeSmsMode: false,
    loginPollTimer: null,
    lastLoginState: false,

    exitConfirmUntil: 0,
    exitConfirmTimer: null,

    refreshIndex: 1,
    fetchingFeed: false,
    topPeekTimer: null,
    lastProgressSaveAt: 0
  };

  var dom = {
    root: null,
    style: null,
    video: null,
    preloadVideo: null,
    stageStatus: null,
    stageStatusMain: null,
    stageStatusSub: null,
    topBar: null,
    authorText: null,
    titleText: null,
    topPills: null,
    loginStage: null,
    loginBadge: null,
    loginQrCard: null,
    loginQrImg: null,
    loginQrMask: null,
    loginAvatar: null,
    loginMaskTitle: null,
    loginMaskSub: null,
    loginQrStatus: null,
    loginActions: null,
    commandMenu: null,
    commandList: null,
    passthroughBanner: null
  };

  // ==================== 1. Native Persistence & System Volume Bridge ====================

  function syncVolumeFromNative() {
    try {
      if (w.DgNative && typeof w.DgNative.getVolumePercent === 'function') {
        var pct = Number(w.DgNative.getVolumePercent());
        if (isFinite(pct) && pct >= 0 && pct <= 100) {
          state.volumePct = Math.round(pct);
        }
      }
    } catch (e) {}
    return state.volumePct;
  }

  function changeSystemVolume(delta) {
    try {
      if (state.muted && delta > 0) {
        state.muted = false;
        if (dom.video) dom.video.muted = false;
      }
      if (w.DgNative && typeof w.DgNative.adjustVolume === 'function') {
        var pct = Number(w.DgNative.adjustVolume(delta));
        if (isFinite(pct) && pct >= 0 && pct <= 100) {
          state.volumePct = Math.round(pct);
        }
      }
    } catch (e) {}
    if (dom.video) {
      dom.video.muted = state.muted;
      dom.video.volume = 1.0;
    }
    renderTopBar();
    if (state.menuOpen) renderCommandMenu();
    return state.volumePct;
  }

  function loadPersistedState() {
    syncVolumeFromNative();
    try {
      var raw = null;
      if (w.DgNative && typeof w.DgNative.loadStateJson === 'function') {
        raw = w.DgNative.loadStateJson();
      }
      if (!raw) {
        raw = w.localStorage ? w.localStorage.getItem('hg_douyin_state_v1') : null;
      }
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (typeof parsed.autoPlayNext === 'boolean') {
        state.autoPlayNext = parsed.autoPlayNext;
      }
      if (Array.isArray(parsed.history)) state.history = parsed.history.slice(0, MAX_HISTORY);
      if (Array.isArray(parsed.favorites)) state.favorites = parsed.favorites.slice(0, MAX_FAVORITES);
      if (parsed.progressMap && typeof parsed.progressMap === 'object') {
        state.progressMap = parsed.progressMap;
      }
    } catch (e) {}
  }

  function savePersistedState() {
    try {
      var payload = JSON.stringify({
        autoPlayNext: state.autoPlayNext,
        history: state.history.slice(0, MAX_HISTORY),
        favorites: state.favorites.slice(0, MAX_FAVORITES),
        progressMap: state.progressMap
      });
      if (w.DgNative && typeof w.DgNative.saveStateJson === 'function') {
        w.DgNative.saveStateJson(payload);
      }
      if (w.localStorage) {
        w.localStorage.setItem('hg_douyin_state_v1', payload);
      }
    } catch (e) {}
  }

  // ---- 云台防抖（3DOF 原生开关，快捷菜单入口）----

  function isGimbalStabOn() {
    try {
      if (w.DgNative && typeof w.DgNative.isGimbalStabilizerOn === 'function') {
        return w.DgNative.isGimbalStabilizerOn() === true;
      }
    } catch (e) {}
    return false;
  }

  var GIMBAL_MODES = ['legacy_follow', 'follow', 'anchored'];
  var GIMBAL_MODE_LABELS = ['1 · 原始跟随', '2 · 预测跟随', '3 · 方向锚定'];

  function getGimbalMode() {
    try {
      var mode = w.DgNative.getGimbalMode();
      return GIMBAL_MODES.indexOf(mode) >= 0 ? mode : 'legacy_follow';
    } catch (e) { return 'legacy_follow'; }
  }

  function isGimbalQualityEnhanced() {
    try { return w.DgNative.isGimbalQualityEnhanced() === true; }
    catch (e) { return true; }
  }

  function toggleGimbalQuality() {
    var enabled = !isGimbalQualityEnhanced();
    try { w.DgNative.setGimbalQualityEnhanced(enabled); } catch (e) { return 'gimbal-fail'; }
    renderCommandMenu();
    return enabled ? 'gimbal-quality-on' : 'gimbal-quality-off';
  }

  function selectItemQuality(item, enhanced) {
    if (item.sourceQualityEnhanced === enhanced) return;
    var profile = item.qualityProfiles && item.qualityProfiles[enhanced ? 'enhanced' : 'original'];
    item.urls = profile ? profile.urls.slice() : [];
    item.qualityLabel = profile ? profile.label : '解析中';
    item.sourceQualityEnhanced = enhanced;
    item.__refreshedOnce = false;
  }

  function applyQualityProfile(enhanced) {
    enhanced = enhanced === true;
    if (enhanced !== isGimbalQualityEnhanced() || qualityProfileEnabled === enhanced) return;
    qualityProfileEnabled = enhanced;
    var version = ++qualitySwitchVersion;
    var item = currentItem();
    var video = dom.video;
    if (item && video && state.view === 'player') {
      qualityResume = {id: item.id, time: video.currentTime || 0, paused: video.paused,
        version: version, holdUntil: Date.now() + 10000};
      setTimeout(function () { if (version === qualitySwitchVersion) syncGimbalActivity(); }, 10000);
    }
    state.queue.concat(state.pendingPool).forEach(function (entry) { selectItemQuality(entry, enhanced); });
    state.preloadedUrl = '';
    if (dom.preloadVideo) { dom.preloadVideo.pause(); dom.preloadVideo.removeAttribute('src'); dom.preloadVideo.load(); }
    renderCommandMenu();
    if (!item || !video || state.view !== 'player') return;
    clearVideoStallTimer();
    video.pause();
    function restart(updated) {
      if (version !== qualitySwitchVersion || currentItem() !== item || state.view !== 'player') return;
      if (updated && updated.urls && updated.urls.length) {
        startVideoUrl(updated, 0);
      } else {
        video.removeAttribute('src'); video.load();
        qualityResume = null; syncGimbalActivity();
        showStageStatus('当前视频的' + (enhanced ? '优化' : '原始') + '画质源不可用', '可切换画质或上下滑动');
      }
    }
    if (item.urls.length) restart(item);
    else fetchAwemeDetail(item.id, restart);
  }

  function toggleGimbalMode() {
    var next = GIMBAL_MODES[(GIMBAL_MODES.indexOf(getGimbalMode()) + 1) % GIMBAL_MODES.length];
    try { w.DgNative.setGimbalMode(next); } catch (e) { return 'gimbal-fail'; }
    setTimeout(renderCommandMenu, 50);
    return 'gimbal-' + next;
  }

  /** 切换云台防抖并同步 html.hg-gimbal（视频纹理化 translateZ 提示）；返回 gimbal-on/off/fail。 */
  function toggleGimbalStabilizer() {
    var wasOn = isGimbalStabOn();
    var nowOn = wasOn;
    try {
      if (w.DgNative && typeof w.DgNative.setGimbalStabilizer === 'function') {
        nowOn = w.DgNative.setGimbalStabilizer(!wasOn) === true;
      }
    } catch (e) { nowOn = wasOn; }
    if (d.documentElement) d.documentElement.classList.toggle('hg-gimbal', nowOn);
    if (nowOn) syncGimbalActivity();
    return wasOn === nowOn ? 'gimbal-fail' : (nowOn ? 'gimbal-on' : 'gimbal-off');
  }

  // 播放状态 → 防抖活动闸门：仅 player 视图且视频播放中才跑原生管线（离屏重绘+GL+IMU），
  // 暂停/登录/原生页自动停（回基线 CPU）。停有 1.5s 延迟：切视频/seek 有短暂 pause，立即停会闪重建。
  var gimbalIdleTimer = null;

  function syncGimbalActivity() {
    if (!isGimbalStabOn()) return;
    var switchingQuality = qualityResume && !qualityResume.paused && Date.now() < qualityResume.holdUntil;
    var playing = state.view === 'player' && dom.video && ((!dom.video.paused && !dom.video.ended) || switchingQuality);
    if (playing) {
      if (gimbalIdleTimer) { clearTimeout(gimbalIdleTimer); gimbalIdleTimer = null; }
      try { if (w.DgNative && typeof w.DgNative.setGimbalActive === 'function') w.DgNative.setGimbalActive(true); } catch (e) {}
    } else if (!gimbalIdleTimer) {
      gimbalIdleTimer = setTimeout(function () {
        gimbalIdleTimer = null;
        try { if (w.DgNative && typeof w.DgNative.setGimbalActive === 'function') w.DgNative.setGimbalActive(false); } catch (e) {}
      }, 1500);
    }
  }

  function reportCurrentVideoId(id) {
    if (!id) return;
    try {
      if (w.DgNative && typeof w.DgNative.saveVideo === 'function') {
        w.DgNative.saveVideo(String(id));
      }
    } catch (e) {}
  }

  // ==================== 2. Data Normalizer & AVC Quality Selection ====================

  function normalizeHttps(url) {
    if (!url || typeof url !== 'string') return '';
    var u = url.trim();
    if (u.indexOf('//') === 0) return 'https:' + u;
    if (u.indexOf('http://') === 0) return 'https://' + u.slice(7);
    return u;
  }

  function getAddrShortEdge(addrObj, gearName) {
    if (addrObj && typeof addrObj === 'object') {
      var wNum = Number(addrObj.width) || 0;
      var hNum = Number(addrObj.height) || 0;
      if (wNum > 0 && hNum > 0) {
        return Math.min(wNum, hNum);
      }
    }
    var g = String(gearName || '');
    var m = g.match(/(2160|1440|1080|720|540|480|360)/);
    if (m) return parseInt(m[1], 10);
    if (addrObj && Array.isArray(addrObj.url_list)) {
      for (var i = 0; i < addrObj.url_list.length; i++) {
        var um = String(addrObj.url_list[i] || '').match(/(?:ratio=|_|\/)(1080|720|540|480|360)p?/i);
        if (um) return parseInt(um[1], 10);
      }
    }
    return 0;
  }

  function pushAddrSplitUrls(directList, redirectList, seen, addrObj) {
    if (!addrObj || !Array.isArray(addrObj.url_list)) return;
    for (var i = 0; i < addrObj.url_list.length; i++) {
      var u = normalizeHttps(addrObj.url_list[i]);
      if (!u || u.indexOf('https://') !== 0 || seen[u]) continue;
      seen[u] = true;
      if (u.indexOf('/aweme/v1/play') !== -1) {
        redirectList.push(u);
      } else {
        directList.push(u);
      }
    }
  }

  function formatShortEdgeLabel(shortEdge) {
    if (!shortEdge || shortEdge <= 0) return '540P';
    if (shortEdge >= 1000) return '1080P';
    if (shortEdge >= 680) return '720P';
    if (shortEdge >= 500) return '540P';
    return '480P';
  }

  /** Accept known resolutions up to 1080p; preserve quality order during CDN fallback. */
  function extractPlayUrls(videoObj, enhanced) {
    if (typeof enhanced !== 'boolean') enhanced = isGimbalQualityEnhanced();
    var maxEdge = enhanced ? MAX_VIDEO_SHORT_EDGE : 540;
    if (!videoObj || typeof videoObj !== 'object') return [];
    var seen = {};
    var direct = [];
    var redirects = [];
    var candidates = [];
    var rates = videoObj.bit_rate || [];
    for (var i = 0; i < rates.length; i++) {
      var br = rates[i];
      if (!br || !br.play_addr) continue;
      // DASH addresses carry video only; the original site pairs them with bit_rate_audio.
      var extra = {};
      try { extra = JSON.parse(br.video_extra || '{}'); } catch (e) {}
      if (String(br.format || extra.format || '').toLowerCase() === 'dash' || extra.audio_file_id) continue;
      var edge = getAddrShortEdge(br.play_addr, br.gear_name);
      if (edge > 0 && edge <= maxEdge) {
        candidates.push({addr: br.play_addr, edge: edge,
          hevc: Boolean(br.is_h265 || br.is_bytevc1), bps: Number(br.bit_rate) || 0});
      }
    }
    var primary = [videoObj.play_addr_lowbr, videoObj.play_addr_h264, videoObj.play_addr, videoObj.download_addr];
    for (var j = 0; j < primary.length; j++) {
      var addr = primary[j];
      var shortEdge = getAddrShortEdge(addr, '');
      if (shortEdge > 0 && shortEdge <= maxEdge) {
        candidates.push({addr: addr, edge: shortEdge, hevc: false, bps: 0});
      }
    }
    candidates.sort(function (a, b) {
      if (!enhanced) return Number(a.hevc) - Number(b.hevc) || b.edge - a.edge || a.bps - b.bps;
      return Number(a.hevc) - Number(b.hevc) || Math.abs(a.edge - TARGET_RESOLUTION) - Math.abs(b.edge - TARGET_RESOLUTION) || b.bps - a.bps;
    });
    var ordered = [];
    for (var k = 0; k < candidates.length; k++) {
      if (enhanced) { direct = []; redirects = []; }
      pushAddrSplitUrls(direct, redirects, seen, candidates[k].addr);
      if (enhanced) ordered = ordered.concat(redirects, direct);
    }
    videoObj.__hgSelectedQuality = formatShortEdgeLabel(candidates.length ? candidates[0].edge : 0);
    return enhanced ? ordered : redirects.concat(direct);
  }

  function extractCoverUrl(videoObj) {
    if (!videoObj || typeof videoObj !== 'object') return '';
    var candidates = [videoObj.cover, videoObj.origin_cover, videoObj.dynamic_cover];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c && Array.isArray(c.url_list) && c.url_list.length > 0) {
        var u = normalizeHttps(c.url_list[0]);
        if (u) return u;
      }
    }
    return '';
  }

  function normalizeAweme(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var aweme = raw.aweme_info || raw;
    var id = aweme.aweme_id || aweme.group_id;
    if (!id) return null;
    id = String(id);
    if (!/^\d{6,32}$/.test(id)) return null;

    var videoObj = aweme.video || {};
    var originalUrls = extractPlayUrls(videoObj, false);
    var originalLabel = videoObj.__hgSelectedQuality;
    var enhancedUrls = extractPlayUrls(videoObj, true);
    var enhancedLabel = videoObj.__hgSelectedQuality;
    var enhanced = isGimbalQualityEnhanced();
    var urls = enhanced ? enhancedUrls : originalUrls;
    if (urls.length === 0) return null;

    if (typeof aweme.user_digged !== 'undefined') state.likedIds[id] = Boolean(Number(aweme.user_digged));
    var authorObj = aweme.author || {};
    var statsObj = aweme.statistics || {};
    var durationMs = videoObj.duration || aweme.duration || 0;
    var durationSec = durationMs > 1000 ? Math.round(durationMs / 1000) : Math.round(durationMs);

    return {
      id: id,
      title: String(aweme.desc || aweme.item_title || aweme.caption || '抖音视频').trim() || '抖音视频',
      author: String(authorObj.nickname || aweme.author_name || '抖音创作者').trim(),
      duration: durationSec > 0 ? durationSec : 0,
      cover: extractCoverUrl(videoObj),
      urls: urls,
      qualityLabel: enhanced ? enhancedLabel : originalLabel,
      sourceQualityEnhanced: enhanced,
      qualityProfiles: {
        original: { urls: originalUrls, label: originalLabel },
        enhanced: { urls: enhancedUrls, label: enhancedLabel }
      },
      stats: {
        digg: statsObj.digg_count || 0,
        collect: statsObj.collect_count || 0,
        comment: statsObj.comment_count || 0
      },
      updatedAt: Date.now()
    };
  }

  function upsertVideoItem(item, autoPlayIfIdle) {
    if (!item || !item.id) return null;
    var existing = state.queueMap[item.id];
    if (existing) {
      if (item.title && item.title !== '抖音视频') existing.title = item.title;
      if (item.author && item.author !== '抖音创作者') existing.author = item.author;
      if (item.duration > 0) existing.duration = item.duration;
      if (item.cover) existing.cover = item.cover;
      if (Array.isArray(item.urls) && item.urls.length > 0 && (!item.fromDom || !existing.urls || existing.urls.length === 0)) {
        existing.urls = item.urls;
        if (item.qualityLabel) existing.qualityLabel = item.qualityLabel;
      }
      if (item.stats && (item.stats.digg || item.stats.collect)) {
        existing.stats = item.stats;
      }
      if (item.qualityProfiles) {
        existing.qualityProfiles = item.qualityProfiles;
        existing.sourceQualityEnhanced = item.sourceQualityEnhanced;
      }
      existing.updatedAt = Date.now();
      if (
        autoPlayIfIdle !== false &&
        state.view === 'player' &&
        state.currentIndex >= 0 &&
        state.queue[state.currentIndex] &&
        state.queue[state.currentIndex].id === existing.id &&
        dom.video &&
        (!dom.video.getAttribute('src') || dom.video.error) &&
        existing.urls &&
        existing.urls.length > 0
      ) {
        playAtIndex(state.currentIndex, true);
      }
      return existing;
    }

    var copy = {
      id: String(item.id),
      title: item.title || '抖音视频',
      author: item.author || '抖音创作者',
      duration: item.duration || 0,
      cover: item.cover || '',
      urls: Array.isArray(item.urls) ? item.urls.slice() : [],
      qualityLabel: item.qualityLabel || '540P',
      sourceQualityEnhanced: item.sourceQualityEnhanced,
      qualityProfiles: item.qualityProfiles,
      stats: item.stats || { digg: 0, collect: 0, comment: 0 },
      updatedAt: Date.now()
    };

    // Enforce initial 2-item cap & incremental 2-item batch cap:
    // Extra items are stored in pendingPool without loading/preloading until user swipes down.
    if (state.queue.length >= state.maxAllowedQueue) {
      if (!state.pendingMap[copy.id]) {
        state.pendingMap[copy.id] = copy;
        state.pendingPool.push(copy);
      }
      return null;
    }

    state.queueMap[copy.id] = copy;
    state.queue.push(copy);

    if (autoPlayIfIdle !== false) {
      maybeStartInitialPlayback();
      renderTopBar();
    }
    return copy;
  }

  function releaseFromPendingPool(count) {
    var added = 0;
    while (added < count && state.pendingPool.length > 0) {
      var nextItem = state.pendingPool.shift();
      if (!nextItem || !nextItem.id) continue;
      delete state.pendingMap[nextItem.id];
      if (state.queueMap[nextItem.id]) continue;
      state.queueMap[nextItem.id] = nextItem;
      state.queue.push(nextItem);
      added++;
    }
    if (added > 0) {
      renderTopBar();
      if (state.menuOpen) renderCommandMenu();
    }
    return added;
  }

  function scanPayloadForAwemes(node, depth, out) {
    if (!node || typeof node !== 'object' || depth > 7) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        scanPayloadForAwemes(node[i], depth + 1, out);
      }
      return;
    }
    if ((node.aweme_id || node.group_id) && (node.video || node.desc !== undefined)) {
      var normalized = normalizeAweme(node);
      if (normalized && normalized.urls.length > 0) {
        out.push(normalized);
        return;
      }
    }
    if (node.aweme_info && typeof node.aweme_info === 'object') {
      scanPayloadForAwemes(node.aweme_info, depth + 1, out);
    }
    var keys = [
      'aweme_list', 'aweme_detail', 'data', 'cards', 'aweme',
      'items', 'mix_items', 'general_search_data', 'cell_info'
    ];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (node[key] && typeof node[key] === 'object') {
        scanPayloadForAwemes(node[key], depth + 1, out);
      }
    }
  }

  function ingestApiPayload(url, data) {
    if (!data || typeof data !== 'object') return;
    var extracted = [];
    scanPayloadForAwemes(data, 0, extracted);
    if (extracted.length === 0) return;

    var isDetail = typeof url === 'string' && url.indexOf('/aweme/detail') !== -1;
    for (var i = 0; i < extracted.length; i++) {
      var item = upsertVideoItem(extracted[i], false);
      if (isDetail && item && state.currentIndex === -1 && state.view === 'player') {
        var idx = state.queue.indexOf(item);
        if (idx >= 0) {
          playAtIndex(idx, true);
        }
      }
    }
    if (state.view === 'player') {
      maybeStartInitialPlayback();
      preloadNextVideo();
    }
    renderTopBar();
    if (state.menuOpen) renderCommandMenu();
  }

  function installNetworkHooks() {
    if (w.__HG_NETWORK_HOOKED__) return;
    w.__HG_NETWORK_HOOKED__ = true;

    function isCandidateApiUrl(url) {
      if (!url || typeof url !== 'string') return false;
      return (
        url.indexOf('/aweme/') !== -1 ||
        url.indexOf('feed') !== -1 ||
        url.indexOf('detail') !== -1 ||
        url.indexOf('recommend') !== -1
      );
    }

    if (typeof w.fetch === 'function') {
      var origFetch = w.fetch;
      w.fetch = function () {
        var args = arguments;
        var req = args[0];
        var url = typeof req === 'string' ? req : (req && req.url ? req.url : '');
        var p = origFetch.apply(this, args);
        if (isCandidateApiUrl(url)) {
          p.then(function (resp) {
            try {
              if (resp && resp.ok && typeof resp.clone === 'function') {
                resp.clone().text().then(function (text) {
                  if (text && text.indexOf('aweme_id') !== -1) {
                    ingestApiPayload(url, JSON.parse(text));
                  }
                }).catch(function () {});
              }
            } catch (e) {}
          }).catch(function () {});
        }
        return p;
      };
    }

    if (w.XMLHttpRequest && w.XMLHttpRequest.prototype) {
      var origOpen = w.XMLHttpRequest.prototype.open;
      var origSend = w.XMLHttpRequest.prototype.send;
      w.XMLHttpRequest.prototype.open = function (method, url) {
        this.__hgUrl = typeof url === 'string' ? url : String(url || '');
        return origOpen.apply(this, arguments);
      };
      w.XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        if (isCandidateApiUrl(xhr.__hgUrl)) {
          xhr.addEventListener('load', function () {
            try {
              if (xhr.status >= 200 && xhr.status < 300) {
                var text = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : null;
                if (text && text.indexOf('aweme_id') !== -1) {
                  ingestApiPayload(xhr.__hgUrl, JSON.parse(text));
                } else if (xhr.responseType === 'json' && xhr.response) {
                  ingestApiPayload(xhr.__hgUrl, xhr.response);
                }
              }
            } catch (e) {}
          });
        }
        return origSend.apply(this, arguments);
      };
    }
  }

  // ==================== 3. SSR / Active Same-Origin Feed Harvester ====================

  function isLoginRelatedView() {
    return state.view === 'login' || (state.view === 'native' && state.nativeSmsMode);
  }

  function stopAllVideosForLogin() {
    clearVideoStallTimer();
    if (dom.video) {
      try {
        dom.video.muted = true;
        if (!dom.video.paused) dom.video.pause();
      } catch (e) {}
    }
    if (dom.preloadVideo) {
      try {
        dom.preloadVideo.muted = true;
        if (!dom.preloadVideo.paused) dom.preloadVideo.pause();
      } catch (e) {}
    }
    try {
      var vids = d.querySelectorAll('video');
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        try {
          v.muted = true;
          if (!v.paused) v.pause();
        } catch (e2) {}
      }
    } catch (e3) {}
  }

  function harvestSsrAndDom() {
    if (!d.body) return;

    if (isLoginRelatedView()) {
      stopAllVideosForLogin();
    } else if (dom.video && state.view === 'player') {
      if (dom.video.muted !== state.muted) dom.video.muted = state.muted;
      if (dom.video.volume !== 1.0) dom.video.volume = 1.0;
    }

    try {
      var renderScript = d.getElementById('RENDER_DATA');
      if (renderScript && !renderScript.__hgParsed && renderScript.textContent) {
        renderScript.__hgParsed = true;
        var decoded = decodeURIComponent(renderScript.textContent);
        var json = JSON.parse(decoded);
        var found = [];
        scanPayloadForAwemes(json, 0, found);
        for (var i = 0; i < found.length; i++) {
          upsertVideoItem(found[i], false);
        }
      }
    } catch (e) {}

    try {
      var vids = d.querySelectorAll('video');
      for (var vIdx = 0; vIdx < vids.length; vIdx++) {
        var v = vids[vIdx];
        if (v.id === 'hg-video' || v.id === 'hg-video-preload') continue;
        if (state.view !== 'native' || state.nativeSmsMode) {
          try {
            v.muted = true;
            if (!v.paused) v.pause();
          } catch (e) {}
        }
      }
    } catch (e) {}

    if (state.view === 'player') {
      maybeStartInitialPlayback();
    }
  }

  function flushFeedWaiters(added) {
    var callbacks = feedWaiters;
    feedWaiters = [];
    callbacks.forEach(function (cb) { cb(added); });
  }
  var feedWaiters = [];
  function fetchFeedBatch(callback, expandQuota, backgroundOnly) {
    if (typeof callback === 'function') feedWaiters.push(callback);
    if (expandQuota) {
      state.maxAllowedQueue = Math.max(state.maxAllowedQueue, state.queue.length + BATCH_LOAD_COUNT);
      var released = releaseFromPendingPool(state.maxAllowedQueue - state.queue.length);
      if (released > 0 && state.queue.length >= state.maxAllowedQueue) {
        preloadNextVideo();
        flushFeedWaiters(true);
        return;
      }
    }

    if (state.fetchingFeed) return;
    state.fetchingFeed = true;
    var count = BATCH_LOAD_COUNT;
    var idx = state.refreshIndex++;
    var endpoints = [
      '/aweme/v1/web/tab/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&count=' + count + '&refresh_index=' + idx + '&update_version_code=170400&pc_client_type=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&platform=PC',
      '/aweme/v1/web/channel/feed/?device_platform=webapp&aid=6383&channel=channel_pc_web&tag_id=&share_aweme_id=&live_insert_type=&count=' + count + '&refresh_index=' + idx + '&pc_client_type=1&version_code=190500&version_name=19.5.0&cookie_enabled=true&platform=PC'
    ];

    var beforeCount = state.queue.length;
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      state.fetchingFeed = false;
      if (state.queue.length < state.maxAllowedQueue && state.pendingPool.length > 0) {
        releaseFromPendingPool(state.maxAllowedQueue - state.queue.length);
      }
      preloadNextVideo();
      flushFeedWaiters(state.queue.length > beforeCount);
    }

    setTimeout(finish, 4000);

    if (typeof w.fetch === 'function') {
      w.fetch(endpoints[0], { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (json) {
          ingestApiPayload(endpoints[0], json);
          if (state.queue.length === beforeCount) {
            return w.fetch(endpoints[1], { credentials: 'include' })
              .then(function (r2) { return r2.json(); })
              .then(function (json2) { ingestApiPayload(endpoints[1], json2); });
          }
        })
        .catch(function () {})
        .finally(finish);
    } else {
      finish();
    }

    if (!backgroundOnly) triggerUnderlyingFeedLoad();
  }

  function fetchAwemeDetail(awemeId, callback) {
    if (!awemeId || !/^\d{6,32}$/.test(String(awemeId))) {
      if (callback) callback(null);
      return;
    }
    var detailUrl = '/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=' + encodeURIComponent(awemeId) + '&pc_client_type=1&version_code=190500&version_name=19.5.0&cookie_enabled=true&platform=PC';
    if (typeof w.fetch !== 'function') {
      if (callback) callback(null);
      return;
    }
    w.fetch(detailUrl, { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        ingestApiPayload(detailUrl, json);
        if (callback) callback(state.queueMap[awemeId] || null);
      })
      .catch(function () {
        if (callback) callback(null);
      });
  }

  function triggerUnderlyingFeedLoad() {
    try {
      var nextBtn = d.querySelector('.xgplayer-playswitch-next, [data-e2e="video-switch-next-arrow"]');
      if (nextBtn && typeof nextBtn.click === 'function') {
        nextBtn.click();
        return;
      }
      w.scrollBy(0, 600);
    } catch (e) {}
  }

  // ==================== 4. Player Engine & Preloader ====================

  function maybeStartInitialPlayback() {
    if (!dom.video || state.currentIndex >= 0 || state.view !== 'player') return;

    for (var i = 0; i < state.queue.length; i++) {
      if (state.queue[i].urls && state.queue[i].urls.length > 0) {
        playAtIndex(i, true);
        return;
      }
    }
  }

  function currentItem() {
    if (state.currentIndex < 0 || state.currentIndex >= state.queue.length) return null;
    return state.queue[state.currentIndex];
  }

  function isFavorited(id) {
    if (!id) return false;
    for (var i = 0; i < state.favorites.length; i++) {
      if (state.favorites[i].id === id) return true;
    }
    return false;
  }

  function recordHistory(item) {
    if (!item || !item.id) return;
    var filtered = [];
    for (var i = 0; i < state.history.length; i++) {
      if (state.history[i].id !== item.id) filtered.push(state.history[i]);
    }
    filtered.unshift({
      id: item.id,
      title: item.title,
      author: item.author,
      duration: item.duration,
      cover: item.cover,
      urls: (item.urls || []).slice(0, 3),
      stats: item.stats || { digg: 0, collect: 0, comment: 0 },
      updatedAt: Date.now()
    });
    state.history = filtered.slice(0, MAX_HISTORY);
    savePersistedState();
  }

  function toggleFavoriteCurrent() {
    var item = currentItem();
    if (!item) return false;
    var exists = false;
    var nextFavs = [];
    for (var i = 0; i < state.favorites.length; i++) {
      if (state.favorites[i].id === item.id) {
        exists = true;
      } else {
        nextFavs.push(state.favorites[i]);
      }
    }
    if (!exists) {
      nextFavs.unshift({
        id: item.id,
        title: item.title,
        author: item.author,
        duration: item.duration,
        cover: item.cover,
        urls: (item.urls || []).slice(0, 3),
        stats: item.stats || { digg: 0, collect: 0, comment: 0 },
        updatedAt: Date.now()
      });
    }
    state.favorites = nextFavs.slice(0, MAX_FAVORITES);
    savePersistedState();
    renderTopBar();
    if (state.menuOpen) renderCommandMenu();
    return !exists;
  }

  function toggleAutoPlayNext() {
    state.autoPlayNext = !state.autoPlayNext;
    savePersistedState();
    renderTopBar();
    if (state.menuOpen) renderCommandMenu();
    return state.autoPlayNext;
  }

  function showStageStatus(mainText, subText) {
    if (!dom.stageStatus) return;
    if (!mainText) {
      dom.stageStatus.classList.add('is-hidden');
      return;
    }
    dom.stageStatusMain.textContent = mainText;
    dom.stageStatusSub.textContent = subText || '';
    dom.stageStatus.classList.remove('is-hidden');
  }

  var lastTailBufferRequestAt = 0;
  function ensureTailBuffer() {
    if (state.view !== 'player' || state.currentIndex < 0 ||
        state.currentIndex !== state.queue.length - 1 || state.fetchingFeed) return;
    var now = Date.now();
    if (now - lastTailBufferRequestAt < 10000) return;
    lastTailBufferRequestAt = now;
    // Expand only once for this tail; retries fill the existing quota.
    fetchFeedBatch(function () { preloadNextVideo(); }, state.maxAllowedQueue <= state.queue.length, true);
  }

  function preloadNextVideo() {
    if (!dom.preloadVideo) return;
    var nextIdx = state.currentIndex + 1;
    if (nextIdx < 0 || nextIdx >= state.queue.length) return;
    var nextItem = state.queue[nextIdx];
    if (nextItem) selectItemQuality(nextItem, isGimbalQualityEnhanced());
    if (!nextItem || !nextItem.urls || nextItem.urls.length === 0) {
      if (nextItem && nextItem.id) fetchAwemeDetail(nextItem.id);
      return;
    }
    var nextUrl = nextItem.urls[0];
    if (nextUrl && state.preloadedUrl !== nextUrl) {
      state.preloadedUrl = nextUrl;
      dom.preloadVideo.src = nextUrl;
      dom.preloadVideo.load();
    }
  }

  function playAtIndex(index, peekHeader) {
    if (!dom.video) return false;
    if (index < 0 || index >= state.queue.length) {
      fetchFeedBatch(null, true);
      return false;
    }

    state.currentIndex = index;
    state.currentUrlIndex = 0;
    var item = state.queue[index];
    selectItemQuality(item, isGimbalQualityEnhanced());
    if (qualityResume && qualityResume.id !== item.id) qualityResume = null;

    reportCurrentVideoId(item.id);
    recordHistory(item);
    ensureTailBuffer();
    renderTopBar();
    if (peekHeader !== false) {
      peekTopBarBriefly();
    }

    if (!item.urls || item.urls.length === 0) {
      showStageStatus('正在解析视频流…', '@' + item.author + ' · ' + item.title.slice(0, 20));
      fetchAwemeDetail(item.id, function (resolved) {
        if (state.currentIndex !== index) return;
        if (resolved && resolved.urls && resolved.urls.length > 0) {
          startVideoUrl(resolved, 0);
        } else {
          showStageStatus('视频流暂不可用', '请上下滑动切换视频');
        }
      });
      return true;
    }

    startVideoUrl(item, 0);
    return true;
  }

  function clearVideoStallTimer() {
    if (videoStallTimer) clearTimeout(videoStallTimer);
    videoStallTimer = null;
  }

  function watchVideoStall(item, urlIdx) {
    clearVideoStallTimer();
    if (state.view !== 'player') return;
    var video = dom.video;
    var position = video.currentTime;
    videoStallTimer = setTimeout(function () {
      videoStallTimer = null;
      if (state.view !== 'player' || video !== dom.video || currentItem() !== item || state.currentUrlIndex !== urlIdx || video.paused || video.ended) return;
      if (video.currentTime > position + 0.2) return;
      startVideoUrl(item, urlIdx + 1);
    }, VIDEO_STALL_TIMEOUT_MS);
  }

  function startVideoUrl(item, urlIdx) {
    clearVideoStallTimer();
    if (state.view !== 'player') {
      stopAllVideosForLogin();
      return;
    }
    if (!dom.video || !item || !item.urls || urlIdx >= item.urls.length) {
      showStageStatus('正在刷新视频源…', item ? item.title.slice(0, 20) : '');
      if (item && item.id && !item.__refreshedOnce) {
        item.__refreshedOnce = true;
        fetchAwemeDetail(item.id, function (updated) {
          if (state.view !== 'player') return;
          if (updated && updated.urls && updated.urls.length > 0) {
            startVideoUrl(updated, 0);
          } else {
            showStageStatus('视频源暂不可用', '请上下滑动切换视频');
          }
        });
      } else {
        showStageStatus('视频源暂不可用', '请上下滑动切换视频');
      }
      return;
    }

    state.currentUrlIndex = urlIdx;
    var url = item.urls[urlIdx];
    showStageStatus('', '');

    if (item.cover) {
      dom.video.poster = item.cover;
    } else {
      dom.video.removeAttribute('poster');
    }

    state.audioProbeStart = null;
    dom.video.src = url;
    dom.video.muted = state.muted;
    dom.video.volume = 1.0;
    dom.video.playbackRate = SPEEDS[state.speedIndex] || 1.0;

    var resume = qualityResume && qualityResume.id === item.id ? qualityResume : null;
    var savedPos = resume ? resume.time : (state.progressMap[item.id] || 0);
    dom.video.onloadedmetadata = function () {
      if (currentItem() !== item || (resume && resume.version !== qualitySwitchVersion)) return;
      if (resume) {
        dom.video.currentTime = Math.max(0, Math.min(savedPos, dom.video.duration - 0.05));
        if (resume.paused) { dom.video.pause(); if (qualityResume === resume) qualityResume = null; }
      } else if (savedPos > 3 && savedPos < dom.video.duration - 4) {
        dom.video.currentTime = savedPos;
      }
    };
    if (resume && resume.paused) { dom.video.load(); return; }

    watchVideoStall(item, urlIdx);
    var playPromise = dom.video.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(function () {
        if (dom.video) {
          dom.video.muted = state.muted;
          dom.video.volume = 1.0;
        }
      });
    }
  }

  function stepVideo(delta) {
    if (state.queue.length === 0) {
      fetchFeedBatch(null, false);
      return 'loading';
    }
    var target = state.currentIndex + delta;
    if (target < 0) {
      target = 0;
      if (state.currentIndex === 0 && dom.video) {
        dom.video.currentTime = 0;
        dom.video.play().catch(function () {});
        return 'video-prev';
      }
    }
    if (target >= state.queue.length) {
      showStageStatus('正在加载下2条推荐视频…', '请稍候');
      var originIndex = state.currentIndex;
      fetchFeedBatch(function () {
        // Resolve one explicit target once, regardless of synchronous cache release
        // or an in-flight background request. Never override a later user action.
        if (state.currentIndex !== originIndex) return;
        if (target < state.queue.length) {
          playAtIndex(target, true);
        } else {
          showStageStatus('暂未加载到新视频', '请稍后再滑动重试');
        }
      }, state.maxAllowedQueue <= state.queue.length, true);
      return 'switching';
    }
    playAtIndex(target, true);
    return delta > 0 ? 'video-next' : 'video-prev';
  }

  function seekBy(seconds) {
    if (!dom.video) return;
    var dur = dom.video.duration || 0;
    var target = (dom.video.currentTime || 0) + seconds;
    if (dur > 0 && isFinite(dur)) {
      target = Math.max(0, Math.min(dur - 0.5, target));
    } else {
      target = Math.max(0, target);
    }
    dom.video.currentTime = target;
    if (state.menuOpen) renderCommandMenu();
  }

  function togglePlayPause() {
    if (!dom.video) return 'no-video';
    dom.video.muted = state.muted;
    dom.video.volume = 1.0;
    if (dom.video.paused) {
      dom.video.play().catch(function () {});
      showStageStatus('', '');
      peekTopBarBriefly();
      return 'play';
    } else {
      dom.video.pause();
      showStageStatus('已暂停', '单击底部菜单 · 长按快捷菜单 · 双击退出');
      if (dom.topBar) dom.topBar.classList.remove('is-hidden');
      return 'pause';
    }
  }

  function cyclePlaybackSpeed() {
    state.speedIndex = (state.speedIndex + 1) % SPEEDS.length;
    var rate = SPEEDS[state.speedIndex];
    if (dom.video) {
      dom.video.playbackRate = rate;
    }
    renderTopBar();
    if (state.menuOpen) renderCommandMenu();
    return rate;
  }

  function toggleMute() {
    state.muted = !state.muted;
    if (dom.video) {
      dom.video.muted = state.muted;
      dom.video.volume = 1.0;
    }
    renderTopBar();
    if (state.menuOpen) renderCommandMenu();
    return state.muted ? 'muted' : 'unmuted';
  }

  // ==================== 5. Hongguo UI Construction & Rendering ====================

  function formatSeconds(sec) {
    var s = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(s / 60);
    var rem = s % 60;
    return (m < 10 ? '0' + m : String(m)) + ':' + (rem < 10 ? '0' + rem : String(rem));
  }

  function ensureViewportAndCss() {
    var head = d.head || d.documentElement;
    if (!head) return;

    var vp = 'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no';
    var metas = d.querySelectorAll('meta[name="viewport"]');
    var dpr = (w.devicePixelRatio && w.devicePixelRatio > 0) ? w.devicePixelRatio : 0.75;
    var targetW = Math.round(480 / dpr);
    var targetH = Math.round(380 / dpr);

    if (metas.length !== 1 || metas[0].getAttribute('content') !== vp) {
      for (var mIdx = 0; mIdx < metas.length; mIdx++) {
        if (metas[mIdx].parentNode) {
          metas[mIdx].parentNode.removeChild(metas[mIdx]);
        }
      }
      var freshMeta = d.createElement('meta');
      freshMeta.name = 'viewport';
      freshMeta.setAttribute('content', vp);
      head.appendChild(freshMeta);
    }

    var style = d.getElementById('hg-douyin-style');
    if (!style && w.__HG_DOUYIN_CSS__) {
      style = d.createElement('style');
      style.id = 'hg-douyin-style';
      style.textContent = w.__HG_DOUYIN_CSS__;
      head.appendChild(style);
      dom.style = style;
    } else if (style && head.lastElementChild !== style) {
      head.appendChild(style);
    }

    try {
      if (d.documentElement) {
        d.documentElement.style.setProperty('min-width', '0px', 'important');
        d.documentElement.style.setProperty('zoom', '1', 'important');
      }
      if (d.body) {
        d.body.style.setProperty('min-width', '0px', 'important');
        d.body.style.setProperty('zoom', '1', 'important');
      }
      if (dom.root) {
        dom.root.style.setProperty('zoom', '1', 'important');
        dom.root.style.setProperty('width', targetW + 'px', 'important');
        dom.root.style.setProperty('height', targetH + 'px', 'important');
      }
    } catch (e) {}

    if (!w.__HG_VP_OBSERVER__ && typeof w.MutationObserver === 'function' && d.documentElement) {
      try {
        var viewportRepairTimer = null;
        function scheduleViewportRepair() {
          if (viewportRepairTimer !== null) return;
          viewportRepairTimer = setTimeout(function () {
            viewportRepairTimer = null;
            ensureViewportAndCss();
          }, 100);
        }
        var obs = new w.MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.type === 'attributes') {
              var t = m.target;
              if (t && t.tagName === 'META' && t.getAttribute('name') === 'viewport' && t.getAttribute('content') !== vp) {
                scheduleViewportRepair();
                return;
              }
            } else if (m.addedNodes && m.addedNodes.length > 0) {
              for (var j = 0; j < m.addedNodes.length; j++) {
                var n = m.addedNodes[j];
                if (n && n.tagName === 'META' && n.getAttribute && n.getAttribute('name') === 'viewport') {
                  scheduleViewportRepair();
                  return;
                }
              }
            }
          }
        });
        obs.observe(d.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] });
        w.__HG_VP_OBSERVER__ = obs;
      } catch (e) {}
    }
  }

  function ensureMounted() {
    ensureViewportAndCss();
    if (!d.body) return;

    var existingRoot = d.getElementById('hg-douyin-root');
    if (existingRoot && dom.root === existingRoot) {
      syncShellClass();
      return;
    }
    if (existingRoot && existingRoot.parentNode) {
      existingRoot.parentNode.removeChild(existingRoot);
    }

    var root = d.createElement('div');
    root.id = 'hg-douyin-root';
    root.innerHTML = [
      '<div class="hg-player-stage">',
      '  <video id="hg-video" playsinline webkit-playsinline autoplay></video>',
      '  <video id="hg-video-preload" playsinline webkit-playsinline muted preload="metadata"></video>',
      '  <div class="hg-stage-status" id="hg-stage-status">',
      '    <div id="hg-stage-status-main">正在接入抖音视频流…</div>',
      '    <div class="hg-stage-status-sub" id="hg-stage-status-sub">滑动切视频 · 单击底部菜单 · 长按快捷菜单</div>',
      '  </div>',
      '  <div class="hg-top-bar" id="hg-top-bar">',
      '    <div class="hg-top-copy">',
      '      <div class="hg-author-row" id="hg-author-text">@抖音精选</div>',
      '      <div class="hg-title-text" id="hg-title-text">正在加载推荐视频…</div>',
      '    </div>',

      '  </div>',
      '</div>',
      '<div class="hg-login-stage is-hidden" id="hg-login-stage">',
      '  <div class="hg-login-header">',
      '    <div class="hg-login-title-group">',
      '      <span class="hg-login-title">抖音账号登录</span>',
      '      <span class="hg-login-badge" id="hg-login-badge">未登录</span>',
      '    </div>',
      '    <span class="hg-login-subhint">滑动选择 · 单击确认 · 双击返回播放</span>',
      '  </div>',
      '  <div class="hg-login-body">',
      '    <div class="hg-login-qr-col">',
      '      <div class="hg-login-qr-card" id="hg-login-qr-card">',
      '        <img class="hg-login-qr-img is-hidden" id="hg-login-qr-img" alt="抖音登录二维码" />',
      '        <div class="hg-login-qr-mask" id="hg-login-qr-mask">',
      '          <img class="hg-login-avatar is-hidden" id="hg-login-avatar" alt="" />',
      '          <div class="hg-login-mask-title" id="hg-login-mask-title">正在生成二维码…</div>',
      '          <div class="hg-login-mask-sub" id="hg-login-mask-sub">正在连接抖音安全认证</div>',
      '        </div>',
      '      </div>',
      '      <div class="hg-login-qr-status" id="hg-login-qr-status">正在获取登录二维码…</div>',
      '    </div>',
      '    <div class="hg-login-info-col">',
      '      <div class="hg-login-steps">',
      '        <div class="hg-login-steps-title">手机抖音 App 扫码步骤</div>',
      '        <div class="hg-login-step-item">1. 打开手机「抖音 App」进入首页</div>',
      '        <div class="hg-login-step-item">2. 点击左上角「扫一扫」图标</div>',
      '        <div class="hg-login-step-item">3. 扫描左侧二维码并在手机端确认登录</div>',
      '      </div>',
      '      <div class="hg-login-actions" id="hg-login-actions"></div>',
      '    </div>',
      '  </div>',
      '</div>',
      '<div class="hg-bottom-menu is-hidden" id="hg-bottom-menu"></div>',
      '<div class="hg-command-menu is-hidden" id="hg-command-menu">',
      '  <div class="hg-command-header">',
      '    <span class="hg-command-title">快捷菜单</span>',
      '    <span class="hg-command-hint">滑动选择 · 单击确认</span>',
      '  </div>',
      '  <div class="hg-command-list" id="hg-command-list"></div>',
      '</div>',
      '<div class="hg-passthrough-banner is-hidden" id="hg-passthrough-banner">原生页面模式 · 长按返回播放</div>'
    ].join('');

    d.body.appendChild(root);

    dom.root = root;
    dom.video = d.getElementById('hg-video');
    dom.preloadVideo = d.getElementById('hg-video-preload');
    dom.stageStatus = d.getElementById('hg-stage-status');
    dom.stageStatusMain = d.getElementById('hg-stage-status-main');
    dom.stageStatusSub = d.getElementById('hg-stage-status-sub');
    dom.topBar = d.getElementById('hg-top-bar');
    dom.authorText = d.getElementById('hg-author-text');
    dom.titleText = d.getElementById('hg-title-text');
    dom.topPills = d.getElementById('hg-top-pills');
    dom.loginStage = d.getElementById('hg-login-stage');
    dom.loginBadge = d.getElementById('hg-login-badge');
    dom.loginQrCard = d.getElementById('hg-login-qr-card');
    dom.loginQrImg = d.getElementById('hg-login-qr-img');
    dom.loginQrMask = d.getElementById('hg-login-qr-mask');
    dom.loginAvatar = d.getElementById('hg-login-avatar');
    dom.loginMaskTitle = d.getElementById('hg-login-mask-title');
    dom.loginMaskSub = d.getElementById('hg-login-mask-sub');
    dom.loginQrStatus = d.getElementById('hg-login-qr-status');
    dom.loginActions = d.getElementById('hg-login-actions');
    dom.bottomMenu = d.getElementById('hg-bottom-menu');
    dom.commandMenu = d.getElementById('hg-command-menu');
    dom.commandList = d.getElementById('hg-command-list');
    dom.passthroughBanner = d.getElementById('hg-passthrough-banner');

    if (dom.loginQrCard) {
      dom.loginQrCard.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleQrFullscreen();
      });
    }

    bindVideoEvents();
    syncShellClass();
    syncGimbalActivity();
    renderTopBar();
    renderLoginActions();

    harvestSsrAndDom();
    if (state.queue.length < INITIAL_QUEUE_CAP) {
      fetchFeedBatch(null, false);
    }
  }

  function syncShellClass() {
    var html = d.documentElement;
    if (!html || !dom.root) return;
    // 云台防抖由原生侧持久化（启动即可能已开启），此处同步视频纹理化 CSS 提示类
    html.classList.toggle('hg-gimbal', isGimbalStabOn());
    if (state.view === 'native') {
      html.classList.remove('hg-shell-active');
      html.classList.add('hg-native-passthrough');
      if (state.nativeSmsMode) {
        html.classList.add('hg-native-sms-login');
      } else {
        html.classList.remove('hg-native-sms-login');
      }
      dom.root.classList.add('is-passthrough');
      if (dom.loginStage) dom.loginStage.classList.add('is-hidden');
      if (dom.passthroughBanner) {
        dom.passthroughBanner.textContent = state.nativeSmsMode
          ? '验证码/密码登录 · 滑动选框 · 单击触发 · 双击返回扫码页'
          : '原生页面模式 · 滑动选框 · 双击返回播放';
        dom.passthroughBanner.classList.remove('is-hidden');
      }
    } else if (state.view === 'login') {
      html.classList.add('hg-shell-active');
      html.classList.remove('hg-native-passthrough');
      html.classList.remove('hg-native-sms-login');
      dom.root.classList.remove('is-passthrough');
      if (dom.loginStage) {
        dom.loginStage.classList.remove('is-hidden');
        dom.loginStage.classList.toggle('is-qr-fullscreen', Boolean(state.qrFullscreen));
      }
      if (dom.passthroughBanner) dom.passthroughBanner.classList.add('is-hidden');
    } else {
      html.classList.add('hg-shell-active');
      html.classList.remove('hg-native-passthrough');
      html.classList.remove('hg-native-sms-login');
      dom.root.classList.remove('is-passthrough');
      if (dom.loginStage) dom.loginStage.classList.add('is-hidden');
      if (dom.passthroughBanner) dom.passthroughBanner.classList.add('is-hidden');
    }
  }

  function updateActiveVideoQuality() {
    var v = dom.video;
    var item = currentItem();
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
      var se = Math.min(v.videoWidth, v.videoHeight);
      state.activeQualityLabel = formatShortEdgeLabel(se);
    } else if (item && item.qualityLabel) {
      state.activeQualityLabel = item.qualityLabel;
    } else {
      state.activeQualityLabel = '540P';
    }
    renderTopBar();
  }

  // Content frames and pose warps have independent clocks: a 25/30fps video does
  // not need a full WebView capture 60 times per second. Older WebViews fall back.
  function trackGimbalVideoFrames(video) {
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    function nextFrame() {
      if (!video.isConnected) return;
      try { w.DgNative.notifyGimbalVideoFrame(); } catch (e) {}
      video.requestVideoFrameCallback(nextFrame);
    }
    video.requestVideoFrameCallback(nextFrame);
  }

  function bindVideoEvents() {
    var v = dom.video;
    if (!v) return;
    trackGimbalVideoFrames(v);

    v.addEventListener('loadedmetadata', function () {
      if (state.view !== 'player') {
        stopAllVideosForLogin();
        return;
      }
      if (Math.min(v.videoWidth, v.videoHeight) > (isGimbalQualityEnhanced() ? MAX_VIDEO_SHORT_EDGE : 540)) {
        v.pause();
        var item = currentItem();
        if (item) startVideoUrl(item, state.currentUrlIndex + 1);
        return;
      }
      updateActiveVideoQuality();
    });

    v.addEventListener('playing', function () {
      if (state.view !== 'player') {
        stopAllVideosForLogin();
        return;
      }
      clearVideoStallTimer();
      if (qualityResume && currentItem() && qualityResume.id === currentItem().id) qualityResume = null;
      v.muted = state.muted;
      v.volume = 1.0;
      updateActiveVideoQuality();
      if (!state.exitConfirmUntil || Date.now() >= state.exitConfirmUntil) {
        showStageStatus('', '');
      }
      preloadNextVideo();
      syncGimbalActivity();
    });

    v.addEventListener('waiting', function () {
      if (state.view !== 'player') return;
      var item = currentItem();
      if (item && !v.paused) watchVideoStall(item, state.currentUrlIndex);
    });

    v.addEventListener('pause', function () {
      clearVideoStallTimer();
      syncGimbalActivity();
    });

    v.addEventListener('ended', function () {
      clearVideoStallTimer();
      if (state.view !== 'player') return;
      var item = currentItem();
      if (item) {
        delete state.progressMap[item.id];
      }
      if (!state.autoPlayNext) {
        v.currentTime = 0;
        v.play().catch(function () {});
        return;
      }
      stepVideo(1);
      syncGimbalActivity();
    });

    v.addEventListener('timeupdate', function () {
      if (state.view !== 'player') {
        stopAllVideosForLogin();
        return;
      }
      // A decodable picture does not guarantee an audio track. Reject silent video-only
      // CDN responses after three seconds of playback, including the first video.
      if (!v.paused && v.readyState >= 3 && typeof v.webkitAudioDecodedByteCount === 'number') {
        if (state.audioProbeStart === null) state.audioProbeStart = v.currentTime;
        if (v.currentTime - state.audioProbeStart >= 3 && v.webkitAudioDecodedByteCount === 0) {
          var silentItem = currentItem();
          if (silentItem) {
            console.warn('[HG audio] video-only source rejected');
            startVideoUrl(silentItem, state.currentUrlIndex + 1);
            return;
          }
        }
      }
      if (v.muted !== state.muted) v.muted = state.muted;
      if (v.volume !== 1.0) v.volume = 1.0;
      var item = currentItem();
      if (item && v.currentTime > 1) {
        state.progressMap[item.id] = Math.floor(v.currentTime);
        var now = Date.now();
        if (now - state.lastProgressSaveAt > 5000) {
          state.lastProgressSaveAt = now;
          savePersistedState();
        }
      }
    });

    v.addEventListener('error', function () {
      if (state.view !== 'player') return;
      var item = currentItem();
      if (!item) return;
      startVideoUrl(item, state.currentUrlIndex + 1);
    });
  }

  function renderTopBar() {
    if (!dom.topBar) return;
    var item = currentItem();
    if (!item) {
      dom.authorText.textContent = '@抖音精选';
      dom.titleText.textContent = state.queue.length > 0 ? '单击开始播放' : '正在同步推荐流…';

      return;
    }

    dom.authorText.textContent = '@' + item.author;
    dom.titleText.textContent = item.title;


  }

  function peekTopBarBriefly() {
    if (!dom.topBar) return;
    dom.topBar.classList.remove('is-hidden');
    if (state.topPeekTimer) clearTimeout(state.topPeekTimer);
    state.topPeekTimer = setTimeout(function () {
      if (dom.topBar && (!dom.video || !dom.video.paused)) {
        dom.topBar.classList.add('is-hidden');
      }
    }, TOP_PEEK_MS);
  }

  // ==================== 6. Hongguo Quick Command Menu (Right Long-Press Drawer) ====================

  function isUserLoggedIn() {
    try {
      var ck = String(d.cookie || '');
      if (/(?:^|;\s*)(?:sessionid|sessionid_ss|sid_guard|uid_tt|LOGIN_STATUS=1)=[^;]+/.test(ck)) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  function getCommandMenuItems() {
    syncVolumeFromNative();
    var item = currentItem();
    var fav = item ? isFavorited(item.id) : false;
    var speed = SPEEDS[state.speedIndex] || 1.0;
    var curSec = dom.video ? (dom.video.currentTime || 0) : 0;
    var durSec = (dom.video && dom.video.duration && isFinite(dom.video.duration))
      ? dom.video.duration
      : (item ? item.duration : 0);
    var timeStr = formatSeconds(curSec) + '/' + formatSeconds(durSec);
    var loggedIn = isUserLoggedIn();

    return [
      {
        id: 'loginPage',
        label: state.view === 'login' ? '返回视频播放' : (loggedIn ? '抖音账号 (已登录)' : '抖音扫码登录'),
        val: state.view === 'login' ? '播放器' : (loggedIn ? '已登录' : '扫码/验证码')
      },
      { id: 'playPause', label: dom.video && dom.video.paused ? '继续播放' : '暂停播放', val: '' },
      { id: 'toggleAutoNext', label: '自动连播', val: state.autoPlayNext ? '开启' : '关闭' },
      { id: 'toggleGimbal', label: '3DoF 防抖', val: isGimbalStabOn() ? '开启' : '关闭' },
      { id: 'gimbalMode', label: '3DoF 模式', val: GIMBAL_MODE_LABELS[GIMBAL_MODES.indexOf(getGimbalMode())] },
      { id: 'gimbalQuality', label: '画质优化', val: isGimbalQualityEnhanced() ? '开启' : '关闭' },
      { id: 'gimbalRecenter', label: '3DoF 回正', val: '' },
      { id: 'next', label: '下一个视频', val: (state.currentIndex + 1) + '/' + state.queue.length },
      { id: 'prev', label: '上一个视频', val: '' },
      { id: 'seekForward', label: '快进 +10秒', val: timeStr },
      { id: 'seekBack', label: '快退 -10秒', val: '' },
      { id: 'refreshFeed', label: '加载更多推荐 (+2)', val: '' },
      { id: 'nativeMode', label: state.view === 'native' ? '返回红果播放器' : '原生页面 (直播/网页)', val: '' }
    ];
  }

  function setBottomOpen(open) {
    state.bottomOpen = open;
    state.bottomMode = 'main';
    state.bottomFocusIdx = 0;
    state.commentRequest++;
    renderBottomMenu();
  }

  function bottomItems() {
    var item = currentItem();
    if (state.bottomMode === 'volume') {
      syncVolumeFromNative();
      return [ {id:'volDown', label:'音量 −'}, {id:'volUp', label:'音量 +'}, {id:'back', label:'返回'} ];
    }
    if (state.bottomMode === 'comments') return [{id:'back',label:'返回菜单'}];
    return [
      {id:'playPause', label: dom.video && dom.video.paused ? '播放' : '暂停'},
      {id:'like', label:item && state.likedIds[item.id] ? '取消点赞' : '点赞'},
      {id:'favorite', label:item && isFavorited(item.id) ? '取消收藏' : '收藏'},
      {id:'comments', label:'查看评论'},
      {id:'volume', label:'音量调整'},
      {id:'quick', label:'快捷菜单'},
      {id:'speed', label:'倍速 ' + (SPEEDS[state.speedIndex] || 1) + '×'}
    ];
  }

  function bottomIcon(id, active) {
    var paths = {
      playPause: dom.video && dom.video.paused
        ? '<path d="M8 5v14l11-7Z"/>'                                       /* 播放 ▶ */
        : '<path d="M7 5h4v14H7ZM13 5h4v14h-4Z"/>',                          /* 暂停 ⏸ */
      like: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
      favorite: '<path d="m12 3 2.8 5.7 6.3.9-4.6 4.4 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z"/>',
      comments: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 2V11.5A8.5 8.5 0 0 1 21 11.5Z"/><path d="M7 10h10M7 14h7"/>',
      volume: '<path d="M3 9h4l5-4v14l-5-4H3Z"/><path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
      quick: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
      speed: '<path d="M4 19a10 10 0 1 1 16 0M12 13l5-6M6 17h12"/><circle cx="12" cy="13" r="1"/>',
      volDown: '<path d="M4 12h16"/>',
      volUp: '<path d="M4 12h16M12 4v16"/>',
      back: '<path d="m10 5-7 7 7 7M3 12h18"/>'
    };
    return '<svg class="hg-bottom-icon" viewBox="0 0 24 24" aria-hidden="true" fill="' + (active ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (paths[id] || paths.quick) + '</svg>';
  }

  function renderBottomMenu() {
    if (!dom.bottomMenu) return;
    dom.bottomMenu.classList.toggle('is-hidden', !state.bottomOpen || state.view !== 'player' || state.menuOpen);
    dom.bottomMenu.innerHTML = '';
    if (!state.bottomOpen) return;
    if (state.bottomMode === 'comments') {
      var comments = d.createElement('div');
      comments.className = 'hg-comments';
      comments.textContent = state.commentStatus;
      state.commentRows.forEach(function (row) {
        var line = d.createElement('div');
        line.className = 'hg-comment-row';
        line.textContent = ((row.user || {}).nickname || '抖音用户') + '：' + (row.text || '');
        comments.appendChild(line);
      });
      dom.bottomMenu.appendChild(comments);
    }
    var list = d.createElement('div');
    list.className = 'hg-bottom-list' + (state.bottomMode !== 'main' ? ' is-submenu' : '');
    bottomItems().forEach(function (entry, idx) {
      var btn = d.createElement('button');
      btn.className = 'hg-bottom-item' + (state.bottomFocusIdx === idx ? ' is-focused' : '');
      btn.type = 'button';
      btn.setAttribute('aria-label', entry.label);
      var item = currentItem();
      var active = item && ((entry.id === 'like' && state.likedIds[item.id]) || (entry.id === 'favorite' && isFavorited(item.id)));
      btn.classList.toggle('is-active', Boolean(active));
      if (entry.id === 'like' || entry.id === 'favorite') btn.setAttribute('aria-pressed', String(Boolean(active)));
      btn.innerHTML = bottomIcon(entry.id, active);
      btn.onclick = function (e) { e.stopPropagation(); state.bottomFocusIdx = idx; activateBottomItem(); };
      list.appendChild(btn);
    });
    dom.bottomMenu.appendChild(list);
  }

  function activateBottomItem() {
    var entry = bottomItems()[state.bottomFocusIdx];
    if (!entry) return 'noop';
    var item = currentItem();
    switch (entry.id) {
      case 'playPause':
        var playResult = togglePlayPause();
        if (playResult === 'play') {
          setBottomOpen(false);   // 恢复播放：收起菜单回全屏；暂停则保留菜单便于继续操作
        } else {
          renderBottomMenu();
        }
        return playResult;   // 'play'/'pause' → HUD 播放/暂停
      case 'quick': openCommandMenu(); return 'menu-open';
      case 'volume': state.bottomMode = 'volume'; state.bottomFocusIdx = 0; break;
      case 'back': state.bottomMode = 'main'; state.bottomFocusIdx = 0; break;
      case 'volUp': changeSystemVolume(1); break;
      case 'volDown': changeSystemVolume(-1); break;
      case 'speed': cyclePlaybackSpeed(); break;
      case 'favorite': toggleFavoriteCurrent(); break;
      case 'like':
        if (!item || state.likePending) return 'noop';
        state.likePending = true;
        var target = !state.likedIds[item.id];
        w.fetch('/aweme/v1/web/commit/item/digg/', {method:'POST', credentials:'include', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'aweme_id=' + encodeURIComponent(item.id) + '&type=' + (target ? '1' : '0') + '&item_type=0&device_platform=webapp&aid=6383'})
          .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
          .then(function (r) { if (r.status_code !== 0) throw new Error(); state.likedIds[item.id] = target; })
          .catch(function () { showStageStatus('点赞未成功，请确认已登录后重试', ''); })
          .then(function () { state.likePending = false; renderBottomMenu(); });
        break;
      case 'comments':
        if (!item) return 'noop';
        state.bottomMode = 'comments'; state.bottomFocusIdx = 0;
        state.commentRows = []; state.commentStatus = '正在加载评论…';
        var request = ++state.commentRequest;
        w.fetch('/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&aweme_id=' + encodeURIComponent(item.id) + '&cursor=0&count=20', {credentials:'include'})
          .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
          .then(function (r) {
            if (request !== state.commentRequest) return;
            if (r.status_code !== 0) throw new Error();
            state.commentRows = r.comments || []; state.commentStatus = state.commentRows.length ? '' : '暂无评论'; renderBottomMenu();
          }).catch(function () { if (request === state.commentRequest) { state.commentStatus = '评论加载失败，请返回后重试'; renderBottomMenu(); } });
        break;
    }
    renderBottomMenu();
    return 'bottom-' + entry.id;
  }

  function openCommandMenu() {
    state.menuOpen = true;
    state.menuFocusIdx = 0;
    if (dom.commandMenu) {
      dom.commandMenu.classList.remove('is-hidden');
    }
    renderCommandMenu();
    renderBottomMenu();
  }

  function closeCommandMenu() {
    state.menuOpen = false;
    if (dom.commandMenu) {
      dom.commandMenu.classList.add('is-hidden');
    }
    renderBottomMenu();
  }

  function renderCommandMenu() {
    if (!dom.commandList) return;
    var items = getCommandMenuItems();
    dom.commandList.innerHTML = '';

    for (var i = 0; i < items.length; i++) {
      (function (idx, entry) {
        var btn = d.createElement('button');
        btn.type = 'button';
        btn.className = 'hg-command-item' + (idx === state.menuFocusIdx ? ' is-focused' : '');
        btn.innerHTML =
          '<span>' + entry.label + '</span>' +
          (entry.val ? '<span class="hg-command-item-val">' + entry.val + '</span>' : '');
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          state.menuFocusIdx = idx;
          executeCommandMenuItem(entry.id);
        });
        dom.commandList.appendChild(btn);
        if (idx === state.menuFocusIdx && btn.scrollIntoView) {
          btn.scrollIntoView({ block: 'nearest' });
        }
      })(i, items[i]);
    }
  }

  function executeCommandMenuItem(id) {
    switch (id) {
      case 'loginPage':
        closeCommandMenu();
        if (state.view === 'login') {
          switchView('player');
          return 'back-player';
        } else {
          switchView('login');
          return 'login-mode';
        }
      case 'playPause':
        togglePlayPause();
        renderCommandMenu();
        return 'play-pause';
      case 'toggleAutoNext':
        var isOn = toggleAutoPlayNext();
        return isOn ? 'autonext-on' : 'autonext-off';
      case 'gimbalMode':
        return toggleGimbalMode();
      case 'gimbalQuality':
        return toggleGimbalQuality();
      case 'gimbalRecenter':
        try { w.DgNative.recenterGimbal(); } catch (e) { return 'gimbal-fail'; }
        closeCommandMenu();
        return 'gimbal-recenter';
      case 'toggleGimbal':
        var gimbalResult = toggleGimbalStabilizer();
        renderCommandMenu();
        return gimbalResult;
      case 'volUp':
        changeSystemVolume(1);
        return 'vol-up';
      case 'volDown':
        changeSystemVolume(-1);
        return 'vol-down';
      case 'next':
        closeCommandMenu();
        return stepVideo(1);
      case 'prev':
        closeCommandMenu();
        return stepVideo(-1);
      case 'seekForward':
        seekBy(10);
        return 'seek-f';
      case 'seekBack':
        seekBy(-10);
        return 'seek-b';
      case 'speed':
        cyclePlaybackSpeed();
        return 'speed';
      case 'favorite':
        var favOn = toggleFavoriteCurrent();
        return favOn ? 'fav-on' : 'fav-off';
      case 'refreshFeed':
        closeCommandMenu();
        showStageStatus('正在加载下2条推荐视频…', '');
        fetchFeedBatch(function () {
          showStageStatus('', '');
        }, true);
        return 'refresh';
      case 'nativeMode':
        closeCommandMenu();
        state.nativeSmsMode = false;
        if (state.view === 'native') {
          switchView('player');
          return 'player-mode';
        } else {
          switchView('native');
          return 'native-mode';
        }
      default:
        closeCommandMenu();
        return 'noop';
    }
  }

  // ==================== 7. Glasses-Adapted Douyin Login View & Native Fallback ====================

  var cachedWebpackReq = null;
  function getWebpackRequire() {
    if (cachedWebpackReq) return cachedWebpackReq;
    try {
      if (Array.isArray(w.webpackChunkdouyin_web)) {
        w.webpackChunkdouyin_web.push([
          ['__hg_login_bridge_' + Date.now()],
          {},
          function (r) { cachedWebpackReq = r; }
        ]);
      }
    } catch (e) {}
    return cachedWebpackReq;
  }

  function getQrComponentFiberProps() {
    try {
      var el = d.getElementById('douyin_login_comp_scan_code');
      if (!el) return null;
      var keys = Object.keys(el);
      var fk = null;
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber') === 0) {
          fk = keys[i];
          break;
        }
      }
      var cur = fk ? el[fk] : null;
      var depth = 0;
      while (cur && depth < 12) {
        var p = cur.memoizedProps;
        if (p && typeof p === 'object' && ('onRefresh' in p || 'qrcodeImg' in p || 'qrcodeStatus' in p)) {
          return p;
        }
        cur = cur.return;
        depth++;
      }
    } catch (e) {}
    return null;
  }

  var webpackFallbackCache = {};
  var lastQrMountAttemptAt = 0;

  function isHealthyWebpackExports(exp) {
    if (!exp || (typeof exp !== 'object' && typeof exp !== 'function')) return false;
    var keys = Object.keys(exp);
    if (keys.length === 0) return false;
    for (var i = 0; i < keys.length; i++) {
      try {
        void exp[keys[i]];
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  function createSafeWebpackRequire(req) {
    function safeReq(id) {
      try {
        var existing = req(id);
        if (isHealthyWebpackExports(existing)) return existing;
      } catch (e) {}
      if (webpackFallbackCache[id]) return webpackFallbackCache[id].exports;
      var mod = { id: id, loaded: false, exports: {} };
      webpackFallbackCache[id] = mod;
      if (req.m && req.m[id]) {
        req.m[id].call(mod.exports, mod, mod.exports, safeReq);
        mod.loaded = true;
      }
      return mod.exports;
    }
    var rKeys = Object.keys(req);
    for (var i = 0; i < rKeys.length; i++) {
      safeReq[rKeys[i]] = req[rKeys[i]];
    }
    return safeReq;
  }

  function ensureUnderlyingQrPanel(forceNow) {
    try {
      if (d.getElementById('douyin_login_comp_scan_code')) {
        return true;
      }
      if (!forceNow && d.getElementById('login-panel-new')) {
        return true;
      }
      var rootEl = d.getElementById('root');
      if (d.readyState === 'loading' || !rootEl || rootEl.children.length === 0) {
        return false;
      }
      var now = Date.now();
      if (!forceNow && now - lastQrMountAttemptAt < 2500) {
        return false;
      }
      lastQrMountAttemptAt = now;

      var req = getWebpackRequire();
      if (req && req.m) {
        var targetId = req.m[213796] ? 213796 : null;
        if (!targetId) {
          var mKeys = Object.keys(req.m);
          for (var i = 0; i < mKeys.length; i++) {
            var src = String(req.m[mKeys[i]]);
            if (src.indexOf('LOGIN_SCAN_CODE') !== -1 && src.indexOf('loginPanelType') !== -1) {
              targetId = mKeys[i];
              break;
            }
          }
        }
        if (targetId) {
          var safeReq = createSafeWebpackRequire(req);
          var mod = safeReq(targetId);
          var fn = mod && (mod.A || mod.default || mod.Z);
          if (typeof fn === 'function') {
            fn({});
            return true;
          }
        }
      }
      if (typeof w.showAccount === 'function') {
        w.showAccount({});
        return true;
      }
    } catch (e) {}
    return false;
  }

  function refreshQrCodeNow() {
    try {
      var props = getQrComponentFiberProps();
      if (props) {
        if (props.qrcodeStatus === 'scanned' && typeof props.cancelLogin === 'function') {
          props.cancelLogin();
        } else if (typeof props.onRefresh === 'function') {
          props.onRefresh();
        }
        if (dom.loginQrStatus) {
          dom.loginQrStatus.textContent = '正在刷新二维码…';
          dom.loginQrStatus.classList.remove('is-ready');
        }
        setTimeout(function () { syncLoginViewDom(false); }, 350);
        return 'qr-refresh';
      }
      var expEl = d.querySelector('#douyin_login_comp_scan_code .l7F58uTM, #douyin_login_comp_scan_code [class*="expired"]');
      if (expEl && typeof expEl.click === 'function') {
        expEl.click();
        setTimeout(function () { syncLoginViewDom(false); }, 350);
        return 'qr-refresh';
      }
      ensureUnderlyingQrPanel(true);
      setTimeout(function () { syncLoginViewDom(true); }, 500);
    } catch (e) {}
    return 'qr-refresh';
  }

  function syncLoginViewDom(autoRefreshIfExpired) {
    if (!dom.loginStage) return;
    var loggedIn = isUserLoggedIn();

    if (dom.loginBadge) {
      dom.loginBadge.textContent = loggedIn ? '已登录' : '未登录';
      if (loggedIn) {
        dom.loginBadge.classList.add('is-ok');
      } else {
        dom.loginBadge.classList.remove('is-ready');
        dom.loginBadge.classList.remove('is-ok');
      }
    }

    if (loggedIn) {
      if (dom.loginQrMask) dom.loginQrMask.classList.remove('is-hidden');
      if (dom.loginAvatar) dom.loginAvatar.classList.add('is-hidden');
      if (dom.loginMaskTitle) dom.loginMaskTitle.textContent = '✓ 已登录抖音账号';
      if (dom.loginMaskSub) dom.loginMaskSub.textContent = '单击「已完成登录」或双击返回播放';
      if (dom.loginQrStatus) {
        dom.loginQrStatus.textContent = '账号已登录 · 推荐流已同步';
        dom.loginQrStatus.classList.add('is-ready');
      }
      if (!state.lastLoginState && state.view === 'login') {
        state.lastLoginState = true;
        fetchFeedBatch(null, true);
      }
      return;
    }
    state.lastLoginState = false;

    var props = getQrComponentFiberProps();
    var qrImgEl = d.querySelector('#douyin_login_comp_scan_code img.RhjdbXj8, #animate_qrcode_container img[aria-label="二维码"]');
    var qrSrc = (props && props.qrcodeImg) || (qrImgEl && qrImgEl.getAttribute('src')) || '';
    var qrStatus = (props && props.qrcodeStatus) || 'new';
    var isExpired = Boolean((props && (props.expired || props.qrcodeStatus === 'expired')) || d.querySelector('#douyin_login_comp_scan_code .l7F58uTM'));

    if (autoRefreshIfExpired && isExpired && props && typeof props.onRefresh === 'function') {
      try { props.onRefresh(); } catch (e) {}
      isExpired = false;
    }

    if (qrStatus === 'scanned' || qrStatus === 'confirmed') {
      if (dom.loginQrMask) dom.loginQrMask.classList.remove('is-hidden');
      var avUrl = (props && props.avatar) || '';
      if (dom.loginAvatar) {
        if (avUrl) {
          dom.loginAvatar.src = avUrl;
          dom.loginAvatar.classList.remove('is-hidden');
        } else {
          dom.loginAvatar.classList.add('is-hidden');
        }
      }
      if (dom.loginMaskTitle) {
        dom.loginMaskTitle.textContent = qrStatus === 'confirmed' ? '正在登录抖音…' : '手机已扫码';
      }
      if (dom.loginMaskSub) {
        dom.loginMaskSub.textContent = qrStatus === 'confirmed' ? '请稍候，正在同步账号状态' : '请在手机抖音 App 点击「确认登录」';
      }
      if (dom.loginQrStatus) {
        dom.loginQrStatus.textContent = '已扫码 · 请在手机端确认';
        dom.loginQrStatus.classList.add('is-ready');
      }
      return;
    }

    if (isExpired) {
      if (qrSrc && dom.loginQrImg) {
        dom.loginQrImg.src = qrSrc;
        dom.loginQrImg.classList.remove('is-hidden');
      }
      if (dom.loginQrMask) dom.loginQrMask.classList.remove('is-hidden');
      if (dom.loginAvatar) dom.loginAvatar.classList.add('is-hidden');
      if (dom.loginMaskTitle) dom.loginMaskTitle.textContent = '二维码已过期';
      if (dom.loginMaskSub) dom.loginMaskSub.textContent = '单击右侧「刷新二维码」重新获取';
      if (dom.loginQrStatus) {
        dom.loginQrStatus.textContent = '二维码已失效 · 请刷新';
        dom.loginQrStatus.classList.remove('is-ready');
      }
      return;
    }

    if (qrSrc && (qrSrc.indexOf('data:image/') === 0 || qrSrc.indexOf('http') === 0)) {
      if (dom.loginQrImg) {
        if (dom.loginQrImg.getAttribute('src') !== qrSrc) {
          dom.loginQrImg.src = qrSrc;
        }
        dom.loginQrImg.classList.remove('is-hidden');
      }
      if (dom.loginQrMask) dom.loginQrMask.classList.add('is-hidden');
      if (dom.loginQrStatus) {
        dom.loginQrStatus.textContent = state.qrFullscreen
          ? '再次单击缩小二维码 · 请使用手机抖音扫码'
          : '请使用手机抖音 App 扫码登录';
        dom.loginQrStatus.classList.add('is-ready');
      }
    } else {
      ensureUnderlyingQrPanel();
      if (dom.loginQrMask) dom.loginQrMask.classList.remove('is-hidden');
      if (dom.loginAvatar) dom.loginAvatar.classList.add('is-hidden');
      if (dom.loginMaskTitle) dom.loginMaskTitle.textContent = '正在获取二维码…';
      if (dom.loginMaskSub) dom.loginMaskSub.textContent = '正在连接抖音安全认证中心';
      if (dom.loginQrStatus) {
        dom.loginQrStatus.textContent = state.qrFullscreen
          ? '再次单击缩小二维码 · 正在加载二维码…'
          : '正在加载登录二维码…';
        dom.loginQrStatus.classList.remove('is-ready');
      }
    }
  }

  function toggleQrFullscreen(forceState) {
    state.qrFullscreen = typeof forceState === 'boolean' ? forceState : !state.qrFullscreen;
    if (dom.loginStage) {
      dom.loginStage.classList.toggle('is-qr-fullscreen', state.qrFullscreen);
    }
    syncLoginViewDom(false);
    renderLoginActions();
    return state.qrFullscreen ? 'qr-zoom-in' : 'qr-zoom-out';
  }

  function getLoginActionItems() {
    return [
      {
        id: 'zoomQr',
        label: state.qrFullscreen ? '缩小二维码' : '放大二维码到全屏',
        val: state.qrFullscreen ? '单击还原' : '全屏扫码'
      },
      { id: 'refreshQr', label: '刷新二维码', val: '重新获取' },
      { id: 'smsLogin', label: '验证码 / 密码登录', val: '切换表单' },
      { id: 'syncFeed', label: '已完成扫码 · 刷新视频', val: '同步状态' },
      { id: 'backPlayer', label: '返回视频播放', val: '双击返回' }
    ];
  }

  function renderLoginActions() {
    if (!dom.loginActions) return;
    var items = getLoginActionItems();
    dom.loginActions.innerHTML = '';

    for (var i = 0; i < items.length; i++) {
      (function (idx, entry) {
        var btn = d.createElement('button');
        btn.type = 'button';
        btn.className = 'hg-login-btn' + (idx === state.loginFocusIdx ? ' is-focused' : '');
        btn.innerHTML =
          '<span>' + entry.label + '</span>' +
          (entry.val ? '<span class="hg-login-btn-val">' + entry.val + '</span>' : '');
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          state.loginFocusIdx = idx;
          renderLoginActions();
          executeLoginAction(entry.id);
        });
        dom.loginActions.appendChild(btn);
      })(i, items[i]);
    }
  }

  function executeLoginAction(id) {
    switch (id) {
      case 'zoomQr':
        return toggleQrFullscreen();
      case 'refreshQr':
        return refreshQrCodeNow();
      case 'smsLogin':
        if (state.qrFullscreen) {
          toggleQrFullscreen(false);
        }
        ensureUnderlyingQrPanel();
        state.nativeSmsMode = true;
        stopAllVideosForLogin();
        switchView('native');
        setTimeout(function () {
          stepNativeFocus(1);
        }, 180);
        return 'sms-login-mode';
      case 'syncFeed':
        if (state.qrFullscreen) {
          toggleQrFullscreen(false);
        }
        switchView('player');
        fetchFeedBatch(function () {
          if (state.queue.length > 0 && state.currentIndex >= 0) {
            playAtIndex(state.currentIndex, true);
          }
        }, true);
        return 'back-player';
      case 'backPlayer':
      default:
        if (state.qrFullscreen) {
          toggleQrFullscreen(false);
        }
        switchView('player');
        return 'back-player';
    }
  }

  function stopLoginPolling() {
    if (state.loginPollTimer) {
      clearInterval(state.loginPollTimer);
      state.loginPollTimer = null;
    }
  }

  function startLoginPolling() {
    stopLoginPolling();
    stopAllVideosForLogin();
    ensureUnderlyingQrPanel();
    syncLoginViewDom(true);
    state.loginPollTimer = setInterval(function () {
      if (state.view !== 'login') {
        stopLoginPolling();
        return;
      }
      stopAllVideosForLogin();
      syncLoginViewDom(false);
    }, 450);
  }

  function switchView(targetView) {
    setBottomOpen(false);
    if (targetView === 'login') {
      state.view = 'login';
      state.nativeSmsMode = false;
      state.loginFocusIdx = 0;
      state.qrFullscreen = false;
      if (dom.loginStage) dom.loginStage.classList.remove('is-qr-fullscreen');
      stopAllVideosForLogin();
      syncShellClass();
      renderLoginActions();
      startLoginPolling();
      syncGimbalActivity();
      return;
    }

    stopLoginPolling();
    state.qrFullscreen = false;
    if (dom.loginStage) dom.loginStage.classList.remove('is-qr-fullscreen');
    state.view = targetView === 'native' ? 'native' : 'player';
    if (state.view !== 'native') {
      state.nativeSmsMode = false;
    }
    syncShellClass();
    syncGimbalActivity();

    if (state.view === 'native') {
      stopAllVideosForLogin();
      state.nativeFocusIdx = -1;
    } else {
      renderTopBar();
      if (dom.video) {
        dom.video.muted = state.muted;
        dom.video.volume = 1.0;
        if (dom.video.paused && currentItem()) {
          if (dom.video.getAttribute('src')) {
            dom.video.play().catch(function () {});
          } else {
            playAtIndex(state.currentIndex, true);
          }
        } else if (!currentItem()) {
          maybeStartInitialPlayback();
        }
      }
    }
  }

  function getNativeFocusableItems() {
    var loginPanel = d.getElementById('login-panel-new') || d.getElementById('douyin_login_comp_h5_panel');
    if (loginPanel) {
      var lr = loginPanel.getBoundingClientRect();
      if (lr.width > 40 && lr.height > 40) {
        var modalNodes = loginPanel.querySelectorAll(
          '.UXzkscqE span, input:not([name="web-login-area-code-input"]), span.gKXDWaPG, #douyin_login_comp_btn_id, button, [role="button"]:not([name="web-login-area-code-input"]), .dy-account-close, [class*="agreement"] span'
        );
        var modalOut = [];
        for (var m = 0; m < modalNodes.length; m++) {
          var mel = modalNodes[m];
          if (state.nativeSmsMode && mel.closest && (mel.closest('#douyin_login_comp_scan_code') || mel.closest('.ZKVC3H8u'))) {
            continue;
          }
          var mr = mel.getBoundingClientRect();
          if (mr.width >= 14 && mr.height >= 14 && mr.bottom > 0 && mr.top < w.innerHeight) {
            modalOut.push(mel);
          }
        }
        if (modalOut.length > 0) return modalOut;
      }
    }

    var all = d.querySelectorAll('a[href], button, [role="button"], input');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest && el.closest('#hg-douyin-root')) continue;
      var r = el.getBoundingClientRect();
      if (r.width >= 24 && r.height >= 20 && r.bottom > 0 && r.top < w.innerHeight) {
        out.push(el);
      }
    }
    return out;
  }

  function stepNativeFocus(delta) {
    var prev = d.querySelectorAll('.hg-native-focus');
    for (var i = 0; i < prev.length; i++) prev[i].classList.remove('hg-native-focus');
    var list = getNativeFocusableItems();
    if (list.length === 0) return 'no-focus';
    state.nativeFocusIdx = (state.nativeFocusIdx + delta + list.length) % list.length;
    var el = list[state.nativeFocusIdx];
    el.classList.add('hg-native-focus');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return delta > 0 ? 'item-next' : 'item-prev';
  }

  function activateNativeFocus() {
    var el = d.querySelector('.hg-native-focus');
    if (el) {
      if (el.tagName === 'INPUT' && typeof el.focus === 'function') {
        el.focus();
      }
      if (typeof el.click === 'function') {
        el.click();
      }
      return 'open';
    }
    return 'no-focus';
  }

  // ==================== 8. Deterministic 1D Gesture State Machine ====================

  function handleSwipe(delta) {
    ensureMounted();

    if (state.menuOpen) {
      var items = getCommandMenuItems();
      state.menuFocusIdx = (state.menuFocusIdx + delta + items.length) % items.length;
      renderCommandMenu();
      return delta > 0 ? 'item-next' : 'item-prev';
    }

    if (state.view === 'login') {
      if (state.qrFullscreen) {
        return 'noop';
      }
      var loginItems = getLoginActionItems();
      state.loginFocusIdx = (state.loginFocusIdx + delta + loginItems.length) % loginItems.length;
      renderLoginActions();
      return delta > 0 ? 'item-next' : 'item-prev';
    }

    if (state.view === 'native') {
      return stepNativeFocus(delta);
    }

    if (state.bottomOpen) {
      if (state.bottomMode === 'comments') {
        var comments = dom.bottomMenu.querySelector('.hg-comments');
        if (comments) comments.scrollTop += delta * 100;
      } else {
        state.bottomFocusIdx = (state.bottomFocusIdx + delta + bottomItems().length) % bottomItems().length;
        renderBottomMenu();
      }
      return 'bottom-focus';
    }
    // Fullscreen feed navigation
    return stepVideo(delta);
  }

  function handleClick() {
    ensureMounted();

    if (state.menuOpen) {
      var items = getCommandMenuItems();
      var chosen = items[state.menuFocusIdx];
      return chosen ? executeCommandMenuItem(chosen.id) : 'noop';
    }

    if (state.view === 'login') {
      if (state.qrFullscreen) {
        return toggleQrFullscreen(false);
      }
      var loginItems = getLoginActionItems();
      var loginChosen = loginItems[state.loginFocusIdx];
      return loginChosen ? executeLoginAction(loginChosen.id) : 'noop';
    }

    if (state.view === 'native') {
      return activateNativeFocus();
    }

    if (state.bottomOpen) return activateBottomItem();
    setBottomOpen(true);
    return 'bottom-open';
  }

  function handleLongPress() {
    ensureMounted();
    if (state.view === 'player' && state.bottomOpen && !state.menuOpen) return activateBottomItem();
    if (state.menuOpen) {
      closeCommandMenu();
      return 'menu-close';
    }
    openCommandMenu();
    return 'menu-open';
  }

  function handleDoubleClick() {
    ensureMounted();
    if (state.menuOpen) {
      closeCommandMenu();
      return 'menu-close';
    }
    if (state.bottomOpen) { setBottomOpen(false); return 'bottom-close'; }
    if (state.view === 'native') {
      if (state.nativeSmsMode) {
        switchView('login');
        return 'login-mode';
      }
      switchView('player');
      return 'back-player';
    }
    if (state.view === 'login') {
      if (state.qrFullscreen) {
        return toggleQrFullscreen(false);
      }
      switchView('player');
      return 'back-player';
    }

    var now = Date.now();
    if (state.exitConfirmUntil && now < state.exitConfirmUntil) {
      state.exitConfirmUntil = 0;
      if (state.exitConfirmTimer) {
        clearTimeout(state.exitConfirmTimer);
        state.exitConfirmTimer = null;
      }
      showStageStatus('正在退出抖音…', '');
      try {
        if (w.DgNative && typeof w.DgNative.exitApp === 'function') {
          w.DgNative.exitApp();
        }
      } catch (e) {}
      return 'exit-app';
    }

    state.exitConfirmUntil = now + EXIT_CONFIRM_WINDOW_MS;
    showStageStatus('再次双击退出抖音', '2.5秒内再次双击确认退出');
    if (state.exitConfirmTimer) {
      clearTimeout(state.exitConfirmTimer);
    }
    state.exitConfirmTimer = setTimeout(function () {
      state.exitConfirmUntil = 0;
      state.exitConfirmTimer = null;
      if (dom.video && dom.video.paused) {
        showStageStatus('已暂停', '单击底部菜单 · 长按快捷菜单 · 双击退出');
      } else {
        showStageStatus('', '');
      }
    }, EXIT_CONFIRM_WINDOW_MS);

    return 'exit-confirm';
  }

  function handleGlassesGesture(gesture) {
    ensureMounted();
    switch (gesture) {
      case 'swipeForward':
      case 'swipeDown':
        return handleSwipe(1);
      case 'swipeBack':
      case 'swipeUp':
        return handleSwipe(-1);
      case 'click':
        return handleClick();
      case 'doubleClick':
        return handleDoubleClick();
      case 'longPress':
        return handleLongPress();
      case 'twoFingerDoubleTap':
        return toggleFavoriteCurrent() ? 'fav-on' : 'fav-off';
      case 'templeClick':
        return toggleMute();
      case 'glassesOff':
        if (dom.video && !dom.video.paused) {
          dom.video.pause();
        }
        return 'pause';
      case 'glassesPutOn':
        peekTopBarBriefly();
        return 'resume-hint';
      default:
        return 'noop';
    }
  }

  // ==================== 9. Bootstrap & Global Bridges ====================

  // Hidden page players must not compete for the glasses' limited video decoders.
  var nativeMediaPlay = w.HTMLMediaElement.prototype.play;
  w.HTMLMediaElement.prototype.play = function () {
    if (this.tagName === 'VIDEO') {
      if (isLoginRelatedView()) {
        try {
          this.muted = true;
          if (!this.paused) this.pause();
        } catch (e) {}
        return Promise.resolve();
      }
      if (this.id !== 'hg-video' && this.id !== 'hg-video-preload' && state.view !== 'native') {
        return Promise.resolve();
      }
    }
    return nativeMediaPlay.apply(this, arguments);
  };

  installNetworkHooks();
  loadPersistedState();

  var engineApi = {
    ensureMounted: ensureMounted,
    onQualityChanged: applyQualityProfile,
    glassesGesture: handleGlassesGesture,
    onSwipe: function (dir) { return handleSwipe(dir >= 0 ? 1 : -1); },
    onClick: handleClick,
    toggleBar: handleLongPress,
    toggleMute: toggleMute,
    pause: function () {
      if (dom.video && !dom.video.paused) dom.video.pause();
      return 'pause';
    },
    canConsumeBack: function () {
      return state.menuOpen || state.bottomOpen || state.view !== 'player';
    },
    getState: function () {
      var item = currentItem();
      return {
        view: state.view,
        qrFullscreen: state.qrFullscreen,
        videoPaused: dom.video ? Boolean(dom.video.paused) : true,
        menuOpen: state.menuOpen,
        bottomOpen: state.bottomOpen,
        bottomMode: state.bottomMode,
        bottomFocusIdx: state.bottomFocusIdx,
        autoPlayNext: state.autoPlayNext,
        queueLen: state.queue.length,
        maxAllowedQueue: state.maxAllowedQueue,
        pendingPoolLen: state.pendingPool.length,
        currentIndex: state.currentIndex,
        activeQualityLabel: state.activeQualityLabel,
        audioDecodedBytes: dom.video ? dom.video.webkitAudioDecodedByteCount : 0,
        muted: state.muted,
        currentItem: item ? { id: item.id, author: item.author, title: item.title, qualityLabel: item.qualityLabel, urlCount: (item.urls || []).length } : null
      };
    }
  };

  w.__HG_DOUYIN_ENGINE__ = engineApi;
  w.HongguoTV = engineApi;
  w.DouyinGlasses = engineApi;

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', function () {
      ensureMounted();
    });
  } else {
    ensureMounted();
  }

  setInterval(function () {
    ensureMounted();
    harvestSsrAndDom();
    ensureTailBuffer();
  }, 1500);
})();
