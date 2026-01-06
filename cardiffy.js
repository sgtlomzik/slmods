(function () {
    'use strict';

    var PLUGIN_VERSION = '1.9.0'; // Обновил версию
    var DEBUG = true;
    
    // ==================== HLS.JS LOADER ====================
    // Загружаем hls.js если его нет (для поддержки m3u8 в Chrome/Firefox/WebOS/Tizen)
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

    // ==================== RUTUBE STREAM API (NEW) ====================
    var RutubeStream = (function() {
        
        function getStreamUrl(videoId, callback) {
            var apiUrl = 'https://rutube.ru/api/play/options/' + videoId + '/?no_404=true&referer=&pver=v2';
            
            log('RutubeStream: получаем поток для', videoId);
            
            $.ajax({
                url: apiUrl,
                dataType: 'json',
                timeout: 10000,
                success: function(data) {
                    if (data && data.video_balancer && data.video_balancer.m3u8) {
                        log('RutubeStream: получен m3u8:', data.video_balancer.m3u8);
                        callback({
                            m3u8: data.video_balancer.m3u8,
                            thumbnail: data.thumbnail_url || null,
                            duration: data.duration || 0
                        });
                    } else {
                        log('RutubeStream: нет m3u8 в ответе');
                        callback(null);
                    }
                },
                error: function(xhr) {
                    log('RutubeStream: ошибка API', xhr.status);
                    // Пробуем через прокси
                    tryWithProxy(videoId, callback);
                }
            });
        }
        
        function tryWithProxy(videoId, callback) {
            var proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(
                'https://rutube.ru/api/play/options/' + videoId + '/?no_404=true&referer=&pver=v2'
            );
            
            $.ajax({
                url: proxyUrl,
                dataType: 'json',
                timeout: 10000,
                success: function(data) {
                    if (data && data.video_balancer && data.video_balancer.m3u8) {
                        callback({ m3u8: data.video_balancer.m3u8 });
                    } else {
                        callback(null);
                    }
                },
                error: function() {
                    callback(null);
                }
            });
        }
        
        return { getStreamUrl: getStreamUrl };
    })();

    // ==================== RUTUBE SEARCH (KEPT FROM ORIGINAL) ====================
    // Оставляем модуль поиска, чтобы найти ID видео по названию фильма
    var RutubeTrailer = (function() {
        var rootuTrailerApi = Lampa.Utils.protocol() + 'trailer.rootu.top/search/';
        var proxy = '';

        function cleanString(str) {
            return str.replace(/[^a-zA-Z\dа-яА-ЯёЁ]+/g, ' ').trim().toLowerCase();
        }

        function search(movie, isTv, callback) {
            var title = movie.title || movie.name || movie.original_title || movie.original_name || '';
            
            log('Rutube: поиск:', title);
            
            if (!title || title.length < 2) {
                callback(null);
                return;
            }

            var year = (movie.release_date || movie.first_air_date || '').substring(0, 4);
            var cleanSearch = cleanString(title);
            var query = cleanString([title, year, 'русский трейлер', isTv ? 'сезон 1' : ''].join(' '));

            var cacheKey = 'cardify_rutube_' + movie.id;
            var cached = sessionStorage.getItem(cacheKey);
            if (cached) {
                var data = JSON.parse(cached);
                callback(data && data.videoId ? data : null);
                return;
            }

            var tmdbId = movie.id ? ('000000' + movie.id) : '';
            if (tmdbId.length > 7) tmdbId = tmdbId.slice(-Math.max(7, (movie.id + '').length));
            var type = isTv ? 'tv' : 'movie';

            if (tmdbId && /^\d+$/.test(tmdbId)) {
                var rootuUrl = rootuTrailerApi + type + '/' + tmdbId + '.json';

                $.ajax({
                    url: rootuUrl,
                    dataType: 'json',
                    timeout: 3000,
                    success: function(data) {
                        if (data && data.length && data[0].url) {
                            var videoId = extractVideoId(data[0].url);
                            if (videoId) {
                                var result = { title: data[0].title, videoId: videoId };
                                log('Rutube: найден videoId =', videoId);
                                sessionStorage.setItem(cacheKey, JSON.stringify(result));
                                callback(result);
                                return;
                            }
                        }
                        searchRutubeApi(query, cleanSearch, year, cacheKey, callback);
                    },
                    error: function() {
                        searchRutubeApi(query, cleanSearch, year, cacheKey, callback);
                    }
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
            var url = (proxy || '') + 'https://rutube.ru/api/search/video/?query=' + 
                encodeURIComponent(query) + '&format=json';

            $.ajax({
                url: url,
                dataType: 'json',
                timeout: 10000,
                success: function(data) {
                    if (!data || !data.results || !data.results.length) {
                        sessionStorage.setItem(cacheKey, JSON.stringify({ videoId: null }));
                        callback(null);
                        return;
                    }

                    var found = null;
                    for (var i = 0; i < data.results.length; i++) {
                        var r = data.results[i];
                        var rTitle = cleanString(r.title || '');
                        
                        if (!r.embed_url) continue;
                        var isTrailer = rTitle.indexOf('трейлер') >= 0 || rTitle.indexOf('trailer') >= 0 || 
                                       rTitle.indexOf('тизер') >= 0 || rTitle.indexOf('тайзер') >= 0;
                        if (!isTrailer) continue;
                        if (r.duration && r.duration > 300) continue;
                        if (rTitle.indexOf(cleanSearch) < 0) continue;
                        if (r.is_hidden || r.is_deleted || r.is_locked || r.is_adult) continue;
                        
                        var videoId = extractVideoId(r.embed_url || r.video_url);
                        if (videoId) {
                            found = { title: r.title, videoId: videoId };
                            break;
                        }
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
        this.playing = false;
        
        log('BackgroundTrailer: создаём для videoId =', video.videoId);
        
        this.background = render.find('.full-start__background');
        
        // Создаём HTML5 video элемент
        this.html = $('\
            <div class="cardify-bg-video">\
                <video class="cardify-bg-video__player" \
                    muted \
                    autoplay \
                    playsinline \
                    loop \
                    preload="auto"></video>\
                <div class="cardify-bg-video__overlay"></div>\
            </div>\
        ');
        
        this.videoElement = this.html.find('video')[0];
        this.background.after(this.html);
        
        // Получаем прямой поток
        RutubeStream.getStreamUrl(video.videoId, function(stream) {
            if (self.destroyed) return;
            
            if (!stream || !stream.m3u8) {
                log('BackgroundTrailer: не удалось получить поток');
                self.destroy();
                return;
            }
            
            log('BackgroundTrailer: загружаем поток');
            self.loadStream(stream.m3u8);
        });
        
        this.loadStream = function(m3u8Url) {
            var video = this.videoElement;
            
            // Проверяем нативную поддержку HLS (Safari, iOS)
            if (video.canPlayType('application/vnd.apple.mpegurl')) {
                log('BackgroundTrailer: нативный HLS');
                video.src = m3u8Url;
                this.setupVideoEvents();
            } 
            // Используем hls.js для других браузеров
            else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                log('BackgroundTrailer: используем hls.js');
                this.hls = new Hls({
                    autoStartLoad: true,
                    startLevel: -1, // auto quality
                    maxBufferLength: 30,
                    maxMaxBufferLength: 60
                });
                this.hls.loadSource(m3u8Url);
                this.hls.attachMedia(video);
                
                this.hls.on(Hls.Events.MANIFEST_PARSED, function() {
                    log('BackgroundTrailer: манифест загружен');
                    video.play().catch(function(e) {
                        log('BackgroundTrailer: ошибка autoplay:', e.message);
                    });
                });
                
                this.hls.on(Hls.Events.ERROR, function(event, data) {
                    if (data.fatal) {
                        log('BackgroundTrailer: фатальная ошибка HLS:', data.type);
                    }
                });
                
                this.setupVideoEvents();
            } 
            // Пробуем напрямую (вдруг mp4)
            else {
                log('BackgroundTrailer: пробуем напрямую');
                video.src = m3u8Url;
                this.setupVideoEvents();
            }
        };
        
        this.setupVideoEvents = function() {
            var video = this.videoElement;
            var self = this;
            
            video.addEventListener('playing', function() {
                log('BackgroundTrailer: PLAYING!');
                self.playing = true;
                self.html.addClass('cardify-bg-video--visible');
                self.background.addClass('cardify-bg-hidden');
            });
            
            video.addEventListener('error', function(e) {
                log('BackgroundTrailer: ошибка видео:', e);
            });
            
            video.addEventListener('loadeddata', function() {
                log('BackgroundTrailer: данные загружены, пробуем play');
                video.play().catch(function(e) {
                    log('BackgroundTrailer: play failed:', e.message);
                });
            });
            
            // Пробуем запустить сразу
            video.play().catch(function(e) {
                log('BackgroundTrailer: начальный play failed:', e.message);
            });
        };
        
        this.destroy = function() {
            if (this.destroyed) return;
            log('BackgroundTrailer: уничтожаем');
            this.destroyed = true;
            
            if (this.hls) {
                this.hls.destroy();
            }
            
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

        function cleanOldCache() {
            var now = Date.now();
            var changed = false;
            for (var id in titleCache) {
                if (now - titleCache[id].timestamp > CACHE_TTL) {
                    delete titleCache[id];
                    changed = true;
                }
            }
            if (changed) Lampa.Storage.set(storageKey, titleCache);
        }

        async function fetchTitles(card) {
            var orig = card.original_title || card.original_name || '';
            var alt = card.alternative_titles?.titles || card.alternative_titles?.results || [];
            var translitObj = alt.find(function(t) { return t.type === "Transliteration" || t.type === "romaji"; });
            var translit = translitObj?.title || translitObj?.data?.title || translitObj?.data?.name || "";
            var ru = alt.find(function(t) { return t.iso_3166_1 === "RU"; })?.title;
            var en = alt.find(function(t) { return t.iso_3166_1 === "US"; })?.title;

            var now = Date.now();
            var cache = titleCache[card.id];
            if (cache && now - cache.timestamp < CACHE_TTL) {
                ru = ru || cache.ru; en = en || cache.en; translit = translit || cache.translit;
            }

            if (!ru || !en || !translit) {
                try {
                    var type = card.first_air_date ? "tv" : "movie";
                    var data = await new Promise(function(res, rej) {
                        Lampa.Api.sources.tmdb.get(type + "/" + card.id + "?append_to_response=translations", {}, res, rej);
                    });
                    var tr = data.translations?.translations || [];
                    var translitData = tr.find(function(t) { return t.type === "Transliteration" || t.type === "romaji"; });
                    translit = translitData?.title || translitData?.data?.title || translitData?.data?.name || translit;
                    if (!ru) { var ruData = tr.find(function(t) { return t.iso_3166_1 === "RU" || t.iso_639_1 === "ru"; }); ru = ruData?.data?.title || ruData?.data?.name; }
                    if (!en) { var enData = tr.find(function(t) { return t.iso_3166_1 === "US" || t.iso_639_1 === "en"; }); en = enData?.data?.title || enData?.data?.name; }
                    titleCache[card.id] = { ru: ru, en: en, translit: translit, timestamp: now };
                    Lampa.Storage.set(storageKey, titleCache);
                } catch (e) {}
            }
            return { original: orig, ru: ru, en: en, translit: translit };
        }

        function render(container, titles) {
            container.find('.cardify-original-titles').remove();
            var lang = Lampa.Storage.get("language") || 'ru';
            var items = [];
            if (titles.original) items.push({ title: titles.original, label: 'Original' });
            if (titles.translit && titles.translit !== titles.original && titles.translit !== titles.en) items.push({ title: titles.translit, label: 'Translit' });
            if (titles.en && lang !== 'en' && titles.en !== titles.original) items.push({ title: titles.en, label: 'EN' });
            if (titles.ru && lang !== 'ru') items.push({ title: titles.ru, label: 'RU' });
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
        OriginalTitle.init();

        Lampa.Lang.add({
            cardify_enable_sound: { ru: 'Включить звук', en: 'Enable sound', uk: 'Увімкнути звук' },
            cardify_enable_trailer: { ru: 'Фоновый трейлер', en: 'Background trailer', uk: 'Фоновий трейлер' },
            cardify_show_original_title: { ru: 'Оригинальное название', en: 'Original title', uk: 'Оригінальна назва' }
        });

        Lampa.Template.add('full_start_new', '<div class="full-start-new cardify"><div class="full-start-new__body"><div class="full-start-new__left hide"><div class="full-start-new__poster"><img class="full-start-new__img full--poster" /></div></div><div class="full-start-new__right"><div class="cardify__left"><div class="full-start-new__head"></div><div class="full-start-new__title">{title}</div><div class="full-start-new__details"></div><div class="full-start-new__buttons"><div class="full-start__button selector button--play"><svg width="28" height="29" viewBox="0 0 28 29" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="14" cy="14.5" r="13" stroke="currentColor" stroke-width="2.7"/><path d="M18.0739 13.634C18.7406 14.0189 18.7406 14.9811 18.0739 15.366L11.751 19.0166C11.0843 19.4015 10.251 18.9204 10.251 18.1506L10.251 10.8494C10.251 10.0796 11.0843 9.5985 11.751 9.9834L18.0739 13.634Z" fill="currentColor"/></svg><span>#{title_watch}</span></div><div class="full-start__button selector button--book"><svg width="21" height="32" viewBox="0 0 21 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 1.5H19C19.2761 1.5 19.5 1.72386 19.5 2V27.9618C19.5 28.3756 19.0261 28.6103 18.697 28.3595L12.6212 23.7303C11.3682 22.7757 9.63183 22.7757 8.37885 23.7303L2.30302 28.3595C1.9739 28.6103 1.5 28.3756 1.5 27.9618V2C1.5 1.72386 1.72386 1.5 2 1.5Z" stroke="currentColor" stroke-width="2.5"/></svg><span>#{settings_input_links}</span></div><div class="full-start__button selector button--reaction"><svg width="38" height="34" viewBox="0 0 38 34" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M37.208 10.97L12.07 0.11C11.72-0.04 11.32-0.04 10.97 0.11C10.63 0.25 10.35 0.53 10.2 0.88L0.11 25.25C0.04 25.42 0 25.61 0 25.8C0 25.98 0.04 26.17 0.11 26.34C0.18 26.51 0.29 26.67 0.42 26.8C0.55 26.94 0.71 27.04 0.88 27.11L17.25 33.89C17.59 34.04 17.99 34.04 18.34 33.89L29.66 29.2C29.83 29.13 29.99 29.03 30.12 28.89C30.25 28.76 30.36 28.6 30.43 28.43L37.21 12.07C37.28 11.89 37.32 11.71 37.32 11.52C37.32 11.33 37.28 11.15 37.21 10.97ZM20.43 29.94L21.88 26.43L25.39 27.89L20.43 29.94ZM28.34 26.02L21.65 23.25C21.3 23.11 20.91 23.11 20.56 23.25C20.21 23.4 19.93 23.67 19.79 24.02L17.02 30.71L3.29 25.02L12.29 3.29L34.03 12.29L28.34 26.02Z" fill="currentColor"/><path d="M25.35 16.98L24.26 14.34L16.96 17.37L15.72 14.38L13.09 15.47L15.42 21.09L25.35 16.98Z" fill="currentColor"/></svg><span>#{title_reactions}</span></div><div class="full-start__button selector button--subscribe hide"></div><div class="full-start__button selector button--options"><svg width="38" height="10" viewBox="0 0 38 10" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="4.89" cy="4.99" r="4.75" fill="currentColor"/><circle cx="18.97" cy="4.99" r="4.75" fill="currentColor"/><circle cx="33.06" cy="4.99" r="4.75" fill="currentColor"/></svg></div></div></div><div class="cardify__right"><div class="full-start-new__reactions selector"><div>#{reactions_none}</div></div><div class="full-start-new__rate-line"><div class="full-start__pg hide"></div><div class="full-start__status hide"></div></div></div></div></div><div class="hide buttons--container"><div class="full-start__button view--torrent hide"></div><div class="full-start__button selector view--trailer"></div></div></div>');

        // CSS UPDATED for HTML5 Video
        var style = $('<style id="cardify-css">.cardify{transition:all .3s}.cardify .full-start-new__body{height:80vh}.cardify .full-start-new__right{display:flex;align-items:flex-end}.cardify .full-start-new__head{margin-bottom:0.3em}.cardify .full-start-new__title{text-shadow:0 0 .1em rgba(0,0,0,0.3);font-size:5em !important;line-height:1.1 !important;margin-bottom:0.15em}.cardify .full-start-new__title img,.cardify .full-start-new__head img,.cardify img.full--logo,.cardify .full-start__title-img{max-height:24em !important;max-width:90% !important;height:auto !important;width:auto !important;object-fit:contain !important}.cardify .full-start-new__details{margin-bottom:0.5em;font-size:1.3em;opacity:0.7}.cardify__left{flex-grow:1;max-width:70%}.cardify__right{display:flex;align-items:center;flex-shrink:0;position:relative}.cardify .full-start-new__reactions{margin:0;margin-right:-2.8em}.cardify .full-start-new__reactions:not(.focus){margin:0}.cardify .full-start-new__reactions:not(.focus)>div:not(:first-child){display:none}.cardify .full-start-new__rate-line{margin:0;margin-left:3.5em}.cardify__background{left:0;transition:opacity 1s ease}.cardify__background.loaded:not(.dim){opacity:1}.cardify__background.cardify-bg-hidden{opacity:0 !important}body:not(.menu--open) .cardify__background{mask-image:linear-gradient(to bottom,white 50%,rgba(255,255,255,0) 100%)}.cardify-bg-video{position:absolute;top:-20%;left:0;right:0;bottom:-20%;z-index:0;opacity:0;transition:opacity 1.5s ease;overflow:hidden;pointer-events:none}.cardify-bg-video--visible{opacity:1}.cardify-bg-video__player{width:100%;height:100%;object-fit:cover;pointer-events:none}.cardify-bg-video__overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(to top,rgba(0,0,0,0.95) 0%,rgba(0,0,0,0.4) 40%,rgba(0,0,0,0.3) 60%,rgba(0,0,0,0.5) 100%);pointer-events:none}body:not(.menu--open) .cardify-bg-video{mask-image:linear-gradient(to bottom,white 50%,rgba(255,255,255,0) 100%)}.cardify-original-titles{margin-bottom:1em;display:flex;flex-direction:column;gap:0.3em}.cardify-original-titles__item{display:flex;align-items:center;gap:0.8em;font-size:1.4em;opacity:0.85}.cardify-original-titles__text{color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.5)}.cardify-original-titles__label{font-size:0.7em;padding:0.2em 0.5em;background:rgba(255,255,255,0.15);border-radius:0.3em;text-transform:uppercase;letter-spacing:0.05em;opacity:0.7}.cardify .original_title{display:none !important}</style>');
        $('head').append(style);

        Lampa.SettingsApi.addComponent({ component: 'cardify', icon: '<svg width="36" height="28" viewBox="0 0 36 28" fill="none"><rect x="1.5" y="1.5" width="33" height="25" rx="3.5" stroke="white" stroke-width="3"/></svg>', name: 'Cardify v' + PLUGIN_VERSION });
        Lampa.SettingsApi.addParam({ component: 'cardify', param: { name: 'cardify_run_trailers', type: 'trigger', default: true }, field: { name: Lampa.Lang.translate('cardify_enable_trailer') } });
        Lampa.SettingsApi.addParam({ component: 'cardify', param: { name: 'cardify_show_original_title', type: 'trigger', default: true }, field: { name: Lampa.Lang.translate('cardify_show_original_title') } });

        var activeTrailers = {};

        Lampa.Listener.follow('full', function(e) {
            if (e.type == 'complite') {
                log('=== Full complite ===');
                var render = e.object.activity.render();
                var activityId = e.object.activity.id || Date.now();
                render.find('.full-start__background').addClass('cardify__background');

                if (Lampa.Storage.field('cardify_show_original_title') !== false && e.data.movie) {
                    OriginalTitle.fetch(e.data.movie).then(function(titles) {
                        OriginalTitle.render(render.find('.cardify__left'), titles);
                    });
                }

                if (Lampa.Storage.field('cardify_run_trailers') !== false && e.data.movie) {
                    log('Ищем трейлер...');
                    var isTv = !!(e.object.method && e.object.method === 'tv');
                    RutubeTrailer.search(e.data.movie, isTv, function(video) {
                        if (video && video.videoId) {
                            log('Трейлер найден, запускаем');
                            if (activeTrailers[activityId]) activeTrailers[activityId].destroy();
                            activeTrailers[activityId] = new BackgroundTrailer(render, video, function() { delete activeTrailers[activityId]; });
                        } else {
                            log('Трейлер не найден');
                        }
                    });
                }
            }
            if (e.type == 'destroy') {
                var activityId = e.object.activity.id || 0;
                if (activeTrailers[activityId]) { activeTrailers[activityId].destroy(); delete activeTrailers[activityId]; }
            }
        });

        log('Плагин инициализирован');
    }

    if (window.appready) startPlugin();
    else Lampa.Listener.follow('app', function(e) { if (e.type == 'ready') startPlugin(); });
})();
