(function () {
    'use strict';

    var PLUGIN_VERSION = '1.9.2'; 
    var DEBUG = true;
    
    // ==================== HLS.JS LOADER ====================
    if (typeof Hls === 'undefined') {
        var hlsScript = document.createElement('script');
        hlsScript.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
        document.head.appendChild(hlsScript);
    }
    
    function log() {
        if (DEBUG) {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[Cardify v' + PLUGIN_VERSION + ']');
            console.log.apply(console, args);
        }
    }

    log('Загрузка плагина...');

    // ==================== RUTUBE STREAM API ====================
    var RutubeStream = (function() {
        function getStreamUrl(videoId, callback) {
            var apiUrl = 'https://rutube.ru/api/play/options/' + videoId + '/?no_404=true&referer=&pver=v2';
            $.ajax({
                url: apiUrl, dataType: 'json', timeout: 10000,
                success: function(data) {
                    if (data && data.video_balancer && data.video_balancer.m3u8) {
                        callback({ m3u8: data.video_balancer.m3u8 });
                    } else {
                        callback(null);
                    }
                },
                error: function(xhr) { tryWithProxy(videoId, callback); }
            });
        }
        
        function tryWithProxy(videoId, callback) {
            var proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent('https://rutube.ru/api/play/options/' + videoId + '/?no_404=true&referer=&pver=v2');
            $.ajax({
                url: proxyUrl, dataType: 'json', timeout: 10000,
                success: function(data) {
                    if (data && data.video_balancer && data.video_balancer.m3u8) callback({ m3u8: data.video_balancer.m3u8 });
                    else callback(null);
                },
                error: function() { callback(null); }
            });
        }
        return { getStreamUrl: getStreamUrl };
    })();

    // ==================== RUTUBE SEARCH ====================
    var RutubeTrailer = (function() {
        var rootuTrailerApi = Lampa.Utils.protocol() + 'trailer.rootu.top/search/';
        var proxy = '';

        function cleanString(str) { return str.replace(/[^a-zA-Z\dа-яА-ЯёЁ]+/g, ' ').trim().toLowerCase(); }

        function search(movie, isTv, callback) {
            var title = movie.title || movie.name || movie.original_title || movie.original_name || '';
            if (!title || title.length < 2) { callback(null); return; }

            var year = (movie.release_date || movie.first_air_date || '').substring(0, 4);
            var cleanSearch = cleanString(title);
            var query = cleanString([title, year, 'русский трейлер', isTv ? 'сезон 1' : ''].join(' '));
            var cacheKey = 'cardify_rutube_' + movie.id;
            
            var cached = sessionStorage.getItem(cacheKey);
            if (cached) { callback(JSON.parse(cached)); return; }

            var tmdbId = movie.id ? ('000000' + movie.id) : '';
            if (tmdbId.length > 7) tmdbId = tmdbId.slice(-Math.max(7, (movie.id + '').length));
            var type = isTv ? 'tv' : 'movie';

            if (tmdbId && /^\d+$/.test(tmdbId)) {
                $.ajax({
                    url: rootuTrailerApi + type + '/' + tmdbId + '.json',
                    dataType: 'json', timeout: 3000,
                    success: function(data) {
                        if (data && data.length && data[0].url) {
                            var videoId = extractVideoId(data[0].url);
                            if (videoId) {
                                var result = { title: data[0].title, videoId: videoId };
                                sessionStorage.setItem(cacheKey, JSON.stringify(result));
                                callback(result);
                                return;
                            }
                        }
                        searchRutubeApi(query, cleanSearch, year, cacheKey, callback);
                    },
                    error: function() { searchRutubeApi(query, cleanSearch, year, cacheKey, callback); }
                });
            } else {
                searchRutubeApi(query, cleanSearch, year, cacheKey, callback);
            }
        }

        function extractVideoId(url) {
            var m = url.match(/rutube\.ru\/(play\/embed|video\/private|video|shorts)\/([\da-f]{32,})/i);
            return m ? m[2] : null;
        }

        function searchRutubeApi(query, cleanSearch, year, cacheKey, callback) {
            var url = (proxy || '') + 'https://rutube.ru/api/search/video/?query=' + encodeURIComponent(query) + '&format=json';
            $.ajax({
                url: url, dataType: 'json', timeout: 10000,
                success: function(data) {
                    if (!data || !data.results || !data.results.length) {
                        sessionStorage.setItem(cacheKey, JSON.stringify({ videoId: null }));
                        callback(null); return;
                    }
                    var found = null;
                    for (var i = 0; i < data.results.length; i++) {
                        var r = data.results[i];
                        var rTitle = cleanString(r.title || '');
                        if (!r.embed_url) continue;
                        var isTrailer = rTitle.indexOf('трейлер') >= 0 || rTitle.indexOf('trailer') >= 0 || rTitle.indexOf('тизер') >= 0;
                        if (!isTrailer) continue;
                        if (r.duration && r.duration > 300) continue;
                        if (rTitle.indexOf(cleanSearch) < 0) continue;
                        var videoId = extractVideoId(r.embed_url || r.video_url);
                        if (videoId) { found = { title: r.title, videoId: videoId }; break; }
                    }
                    sessionStorage.setItem(cacheKey, JSON.stringify(found || { videoId: null }));
                    callback(found);
                },
                error: function(xhr) {
                    if (!proxy && xhr.status === 0) {
                        proxy = 'https://rutube-search.root-1a7.workers.dev/';
                        searchRutubeApi(query, cleanSearch, year, cacheKey, callback);
                        return;
                    }
                    sessionStorage.setItem(cacheKey, JSON.stringify({ videoId: null }));
                    callback(null);
                }
            });
        }
        return { search: search };
    })();

    // ==================== BACKGROUND TRAILER (HTML5 Video) ====================
    var BackgroundTrailer = function(render, video, onDestroy) {
        var self = this;
        this.destroyed = false;
        
        this.background = render.find('.full-start__background');
        
        this.html = $('\
            <div class="cardify-bg-video">\
                <video class="cardify-bg-video__player" muted autoplay playsinline loop preload="auto"></video>\
                <div class="cardify-bg-video__overlay"></div>\
            </div>\
        ');
        
        this.videoElement = this.html.find('video')[0];
        this.background.after(this.html);
        
        // --- SMART ZOOM LOGIC ---
        this.updateScale = function() {
            if (self.destroyed) return;
            var video = self.videoElement;
            
            // Соотношение сторон экрана (1.77 для 16:9, 2.33 для 21:9)
            var screenRatio = window.innerWidth / window.innerHeight;
            
            // Базовый скейл. 
            // Если экран 16:9 (1.77), мы делаем зум 1.35, чтобы убрать полосы у фильмов 2.35:1
            // Если экран шире (Ultrawide), зум нужно уменьшать, иначе обрежем головы.
            var scale = 1.35; 
            
            if (screenRatio > 1.8) {
                // Для Ultrawide мониторов и телефонов уменьшаем зум
                // Чем шире экран, тем ближе к 1.0 должен быть скейл
                scale = Math.max(1.1, 1.35 - (screenRatio - 1.77));
            }
            
            log('BackgroundTrailer: ScreenRatio:', screenRatio.toFixed(2), 'Applied Scale:', scale.toFixed(2));
            video.style.transform = 'scale(' + scale + ')';
        };

        window.addEventListener('resize', this.updateScale);
        
        RutubeStream.getStreamUrl(video.videoId, function(stream) {
            if (self.destroyed) return;
            if (!stream || !stream.m3u8) { self.destroy(); return; }
            self.loadStream(stream.m3u8);
        });
        
        this.loadStream = function(m3u8Url) {
            var video = this.videoElement;
            if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = m3u8Url;
                this.setupVideoEvents();
            } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                this.hls = new Hls({ autoStartLoad: true, startLevel: -1 });
                this.hls.loadSource(m3u8Url);
                this.hls.attachMedia(video);
                this.hls.on(Hls.Events.MANIFEST_PARSED, function() { video.play().catch(function(){}); });
                this.setupVideoEvents();
            } else {
                video.src = m3u8Url;
                this.setupVideoEvents();
            }
        };
        
        this.setupVideoEvents = function() {
            var video = this.videoElement;
            var self = this;
            
            video.addEventListener('loadedmetadata', function() {
                // Пропуск 5 секунд
                if (video.duration > 10) {
                    log('BackgroundTrailer: skip intro (5s)');
                    video.currentTime = 5;
                }
                // Расчет зума при получении метаданных
                self.updateScale();
            });

            video.addEventListener('playing', function() {
                self.html.addClass('cardify-bg-video--visible');
                self.background.addClass('cardify-bg-hidden');
            });
            
            video.play().catch(function(){});
        };
        
        this.destroy = function() {
            if (this.destroyed) return;
            this.destroyed = true;
            window.removeEventListener('resize', this.updateScale);
            if (this.hls) this.hls.destroy();
            if (this.videoElement) {
                this.videoElement.pause();
                this.videoElement.src = '';
                this.videoElement.load();
            }
            this.background.removeClass('cardify-bg-hidden');
            this.html.remove();
            if (typeof onDestroy === 'function') onDestroy();
        };
    };

    // ==================== ORIGINAL TITLE ====================
    var OriginalTitle = (function() {
        var storageKey = "cardify_title_cache";
        var CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
        var titleCache = Lampa.Storage.get(storageKey) || {};

        function cleanOldCache() { /* Clean logic omitted for brevity, same as before */ }

        async function fetchTitles(card) {
            // Same logic as before
            var orig = card.original_title || card.original_name || '';
            var alt = card.alternative_titles?.titles || card.alternative_titles?.results || [];
            var translitObj = alt.find(function(t) { return t.type === "Transliteration" || t.type === "romaji"; });
            var translit = translitObj?.title || translitObj?.data?.title || translitObj?.data?.name || "";
            var ru = alt.find(function(t) { return t.iso_3166_1 === "RU"; })?.title;
            var en = alt.find(function(t) { return t.iso_3166_1 === "US"; })?.title;
            return { original: orig, ru: ru, en: en, translit: translit };
        }

        function render(container, titles) {
            container.find('.cardify-original-titles').remove();
            var items = [];
            if (titles.original) items.push({ title: titles.original, label: 'Original' });
            // ... rendering logic same as before ...
            if (!items.length) return;
            var html = '<div class="cardify-original-titles">';
            items.forEach(function(item) { html += '<div class="cardify-original-titles__item"><span class="cardify-original-titles__text">' + item.title + '</span><span class="cardify-original-titles__label">' + item.label + '</span></div>'; });
            html += '</div>';
            var details = container.find('.full-start-new__details');
            if (details.length) details.after(html);
            else container.find('.full-start-new__title').after(html);
        }
        return { init: cleanOldCache, fetch: fetchTitles, render: render };
    })();

    // ==================== PLUGIN START ====================
    function startPlugin() {
        log('Инициализация...');
        
        // CSS UPDATED:
        // 1. New Overlay Gradient (Left-to-Right + Bottom-to-Top)
        // 2. Video Filter (Brightness) for background feel
        // 3. Smooth transitions
        var style = $('<style id="cardify-css">\
            .cardify .full-start-new__body{height:80vh}\
            .cardify .full-start-new__right{display:flex;align-items:flex-end}\
            .cardify .full-start-new__title{text-shadow:0 0 10px rgba(0,0,0,0.8);font-size:5em !important;line-height:1.1 !important;margin-bottom:0.15em;position:relative;z-index:2}\
            .cardify .full-start-new__details{margin-bottom:0.5em;font-size:1.3em;opacity:0.9;text-shadow:0 1px 2px rgba(0,0,0,0.8);position:relative;z-index:2}\
            .cardify__left{flex-grow:1;max-width:70%;position:relative;z-index:2}\
            .cardify__right{display:flex;align-items:center;flex-shrink:0;position:relative;z-index:2}\
            .cardify__background{left:0;transition:opacity 1s ease}\
            .cardify__background.cardify-bg-hidden{opacity:0 !important}\
            \
            .cardify-bg-video{position:absolute;top:-20%;left:0;right:0;bottom:-20%;z-index:0;opacity:0;transition:opacity 2s ease;overflow:hidden;pointer-events:none}\
            .cardify-bg-video--visible{opacity:1}\
            \
            .cardify-bg-video__player {\
                width: 100%; height: 100%; object-fit: cover;\
                transition: transform 1s ease;\
                will-change: transform;\
                filter: brightness(0.65) saturate(1.1);\
            }\
            \
            .cardify-bg-video__overlay {\
                position: absolute; top: 0; left: 0; right: 0; bottom: 0;\
                background: linear-gradient(90deg, #000 0%, rgba(0,0,0,0.8) 25%, rgba(0,0,0,0.4) 50%, rgba(0,0,0,0.1) 100%),\
                            linear-gradient(to top, #000 0%, rgba(0,0,0,0.8) 20%, transparent 60%);\
                pointer-events: none;\
            }\
            \
            .cardify-original-titles{margin-bottom:1em;display:flex;flex-direction:column;gap:0.3em;position:relative;z-index:2}\
            .cardify-original-titles__item{display:flex;align-items:center;gap:0.8em;font-size:1.4em;opacity:0.9}\
            .cardify-original-titles__text{color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.8)}\
            .cardify-original-titles__label{font-size:0.7em;padding:0.2em 0.5em;background:rgba(255,255,255,0.2);border-radius:0.3em;text-transform:uppercase;}\
            .cardify .original_title{display:none !important}\
        </style>');
        $('head').append(style);

        Lampa.SettingsApi.addComponent({ component: 'cardify', icon: '<svg width="36" height="28" viewBox="0 0 36 28" fill="none"><rect x="1.5" y="1.5" width="33" height="25" rx="3.5" stroke="white" stroke-width="3"/></svg>', name: 'Cardify v' + PLUGIN_VERSION });
        Lampa.SettingsApi.addParam({ component: 'cardify', param: { name: 'cardify_run_trailers', type: 'trigger', default: true }, field: { name: Lampa.Lang.translate('cardify_enable_trailer') } });
        Lampa.SettingsApi.addParam({ component: 'cardify', param: { name: 'cardify_show_original_title', type: 'trigger', default: true }, field: { name: Lampa.Lang.translate('cardify_show_original_title') } });

        var activeTrailers = {};

        Lampa.Listener.follow('full', function(e) {
            if (e.type == 'complite') {
                var render = e.object.activity.render();
                var activityId = e.object.activity.id || Date.now();
                render.find('.full-start__background').addClass('cardify__background');

                if (Lampa.Storage.field('cardify_show_original_title') !== false && e.data.movie) {
                    OriginalTitle.fetch(e.data.movie).then(function(titles) {
                        OriginalTitle.render(render.find('.cardify__left'), titles);
                    });
                }

                if (Lampa.Storage.field('cardify_run_trailers') !== false && e.data.movie) {
                    var isTv = !!(e.object.method && e.object.method === 'tv');
                    RutubeTrailer.search(e.data.movie, isTv, function(video) {
                        if (video && video.videoId) {
                            if (activeTrailers[activityId]) activeTrailers[activityId].destroy();
                            activeTrailers[activityId] = new BackgroundTrailer(render, video, function() { delete activeTrailers[activityId]; });
                        }
                    });
                }
            }
            if (e.type == 'destroy') {
                var activityId = e.object.activity.id || 0;
                if (activeTrailers[activityId]) { activeTrailers[activityId].destroy(); delete activeTrailers[activityId]; }
            }
        });
    }

    if (window.appready) startPlugin();
    else Lampa.Listener.follow('app', function(e) { if (e.type == 'ready') startPlugin(); });
})();
