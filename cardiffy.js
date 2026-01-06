(function () {
    'use strict';

    var PLUGIN_VERSION = '2.3.0';
    var DEBUG = true;
    var LOG_PREFIX = 'Cardify';

    var CONFIG = {
        AJAX_TIMEOUT: 8000,
        ROOTU_TIMEOUT: 3000,
        STREAM_TIMEOUT: 6000,
        VIDEO_SKIP_SECONDS: 5,
        VIDEO_MIN_DURATION_FOR_SKIP: 10,
        MAX_TRAILER_DURATION: 300,
        CACHE_TTL_MS: 30 * 24 * 60 * 60 * 1000,
        STREAM_CACHE_TTL_MS: 2 * 60 * 60 * 1000,
        HLS_START_LEVEL: 0,
        HLS_MAX_BUFFER: 15,
        SCALE_BASE: 1.35,
        SCALE_MIN: 1.1,
        ASPECT_THRESHOLD: 1.77,
        PREFETCH_DELAY: 300,
        PREFETCH_ENABLED: true
    };

    if (typeof $ === 'undefined' && typeof jQuery === 'undefined') {
        console.log(LOG_PREFIX, 'ERROR: jQuery is required');
        return;
    }
    var $ = window.$ || window.jQuery;

    function log() {
        if (!DEBUG) return;
        var args = Array.prototype.slice.call(arguments);
        var message = args.map(function(arg) {
            if (typeof arg === 'object') {
                try { return JSON.stringify(arg); } catch(e) { return String(arg); }
            }
            return String(arg);
        }).join(' | ');
        console.log(LOG_PREFIX, message);
    }

    var Diag = {
        results: [],
        add: function(category, message, data) {
            this.results.push({ time: new Date().toLocaleTimeString(), cat: category, msg: message, data: data || null });
            if (data) { log('[' + category + ']', message, data); } 
            else { log('[' + category + ']', message); }
        }
    };

    log('Plugin loading... v' + PLUGIN_VERSION);
    
    var videoSupport = (function() {
        var video = document.createElement('video');
        var support = {
            nativeHLS: video.canPlayType('application/vnd.apple.mpegurl'),
            mp4: video.canPlayType('video/mp4'),
            MSE: typeof MediaSource !== 'undefined',
            MSE_H264: false
        };
        if (support.MSE) {
            try { support.MSE_H264 = MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'); } catch(e) {}
        }
        Diag.add('SUPPORT', 'Video capabilities', support);
        return support;
    })();

    var hlsReady = new Promise(function(resolve) {
        if (typeof Hls !== 'undefined') {
            Diag.add('HLS.JS', 'Already loaded');
            resolve(true);
            return;
        }
        var script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.4.12';
        script.onload = function() {
            Diag.add('HLS.JS', 'Loaded', { supported: typeof Hls !== 'undefined' && Hls.isSupported() });
            resolve(true);
        };
        script.onerror = function() {
            Diag.add('HLS.JS', 'FAILED to load');
            resolve(false);
        };
        document.head.appendChild(script);
    });

    var Utils = {
        _counter: 0,
        generateId: function(prefix) { return (prefix || 'cardify') + '_' + (++this._counter) + '_' + Date.now(); },
        cleanString: function(str) { return (str || '').replace(/[^a-zA-Z\dа-яА-ЯёЁ]+/g, ' ').trim().toLowerCase(); },
        extractVideoId: function(url) {
            if (!url) return null;
            var m = url.match(/rutube\.ru\/(play\/embed|video\/private|video|shorts)\/([\da-f]{32,})/i);
            return m ? m[2] : null;
        },
        getMovieCacheKey: function(movie) {
            return 'cardify_' + (movie.id || movie.imdb_id || Utils.cleanString(movie.title || movie.name));
        }
    };

    var AjaxManager = {
        _requests: {},
        request: function(options, groupId) {
            var self = this;
            var requestId = Utils.generateId('ajax');
            var xhr = $.ajax($.extend({}, options, {
                complete: function(jqXHR, status) {
                    delete self._requests[requestId];
                    if (options.complete) options.complete(jqXHR, status);
                }
            }));
            this._requests[requestId] = { xhr: xhr, groupId: groupId };
            return requestId;
        },
        abortGroup: function(groupId) {
            var self = this;
            Object.keys(this._requests).forEach(function(id) {
                if (self._requests[id].groupId === groupId) {
                    self._requests[id].xhr.abort();
                    delete self._requests[id];
                }
            });
        },
        abortAll: function() {
            var self = this;
            Object.keys(this._requests).forEach(function(id) {
                self._requests[id].xhr.abort();
                delete self._requests[id];
            });
        }
    };

    var TrailerCache = {
        _memoryCache: {},
        get: function(movie) {
            var key = Utils.getMovieCacheKey(movie);
            if (this._memoryCache[key]) {
                var mem = this._memoryCache[key];
                if (Date.now() - mem.timestamp < CONFIG.STREAM_CACHE_TTL_MS) return mem.data;
            }
            try {
                var stored = sessionStorage.getItem(key);
                if (stored) {
                    var parsed = JSON.parse(stored);
                    if (parsed.videoId && Date.now() - parsed.timestamp < CONFIG.CACHE_TTL_MS) {
                        this._memoryCache[key] = { data: parsed, timestamp: parsed.timestamp };
                        return parsed;
                    }
                }
            } catch (e) {}
            return null;
        },
        set: function(movie, data) {
            var key = Utils.getMovieCacheKey(movie);
            var record = $.extend({}, data, { timestamp: Date.now() });
            this._memoryCache[key] = { data: record, timestamp: Date.now() };
            try { sessionStorage.setItem(key, JSON.stringify(record)); } catch (e) {}
        }
    };

    var DebouncedStorage = {
        _pending: {}, _timeouts: {},
        set: function(key, value, delay) {
            var self = this; delay = delay || 1000;
            this._pending[key] = value;
            if (this._timeouts[key]) clearTimeout(this._timeouts[key]);
            this._timeouts[key] = setTimeout(function() {
                Lampa.Storage.set(key, self._pending[key]);
                delete self._pending[key]; delete self._timeouts[key];
            }, delay);
        },
        flush: function(key) {
            if (key && this._pending[key] !== undefined) {
                clearTimeout(this._timeouts[key]);
                Lampa.Storage.set(key, this._pending[key]);
                delete this._pending[key]; delete this._timeouts[key];
            } else if (!key) {
                var self = this;
                Object.keys(this._pending).forEach(function(k) { self.flush(k); });
            }
        }
    };

    // ==================== RUTUBE API v3 - ИСПОЛЬЗУЕМ LAMPA NETWORK ====================
    var RutubeAPI = (function() {
        var rootuApi = Lampa.Utils.protocol() + 'trailer.rootu.top/search/';
        var searchProxy = '';
        
        // Получаем прокси из настроек Lampa
        function getLampaProxy() {
            // Lampa использует свой прокси для обхода CORS
            var proxy = Lampa.Storage.get('proxy_url') || Lampa.Storage.get('proxy');
            if (proxy) return proxy;
            
            // Стандартные прокси Lampa
            var protocol = Lampa.Utils.protocol();
            return protocol + 'proxy.cub.watch/';
        }
        
        // Метод 1: Через Lampa.Network (встроенный механизм)
        function tryLampaNetwork(videoId, callback, groupId) {
            Diag.add('STREAM', 'Method 1: Lampa.Network');
            
            var apiUrl = 'https://rutube.ru/api/play/options/' + videoId + '/?no_404=true&referer=&pver=v2';
            
            // Используем Lampa.Network который умеет обходить CORS
            if (typeof Lampa.Network !== 'undefined' && Lampa.Network.native) {
                Lampa.Network.native(apiUrl, function(data) {
                    try {
                        var json = typeof data === 'string' ? JSON.parse(data) : data;
                        if (json && json.video_balancer && json.video_balancer.m3u8) {
                            Diag.add('STREAM', 'Lampa.Network SUCCESS!');
                            callback({ m3u8: json.video_balancer.m3u8 });
                            return;
                        }
                    } catch(e) {
                        Diag.add('STREAM', 'Lampa.Network parse error', { error: e.message });
                    }
                    tryLampaRequest(videoId, callback, groupId);
                }, function(error) {
                    Diag.add('STREAM', 'Lampa.Network failed', { error: error });
                    tryLampaRequest(videoId, callback, groupId);
                }, false, { dataType: 'json' });
            } else {
                Diag.add('STREAM', 'Lampa.Network not available');
                tryLampaRequest(videoId, callback, groupId);
            }
        }
        
        // Метод 2: Через Lampa.Reguest с прокси
        function tryLampaRequest(videoId, callback, groupId) {
            Diag.add('STREAM', 'Method 2: Lampa.Reguest');
            
            var apiUrl = 'https://rutube.ru/api/play/options/' + videoId + '/?no_404=true&referer=&pver=v2';
            
            if (typeof Lampa.Reguest !== 'undefined') {
                var network = new Lampa.Reguest();
                network.timeout(CONFIG.STREAM_TIMEOUT);
                
                network.native(apiUrl, function(data) {
                    try {
                        var json = typeof data === 'string' ? JSON.parse(data) : data;
                        if (json && json.video_balancer && json.video_balancer.m3u8) {
                            Diag.add('STREAM', 'Lampa.Reguest SUCCESS!');
                            callback({ m3u8: json.video_balancer.m3u8 });
                            return;
                        }
                    } catch(e) {}
                    tryServerProxy(videoId, callback, groupId);
                }, function() {
                    Diag.add('STREAM', 'Lampa.Reguest failed');
                    tryServerProxy(videoId, callback, groupId);
                });
            } else {
                Diag.add('STREAM', 'Lampa.Reguest not available');
                tryServerProxy(videoId, callback, groupId);
            }
        }
        
        // Метод 3: Через серверный прокси Lampa
        function tryServerProxy(videoId, callback, groupId) {
            Diag.add('STREAM', 'Method 3: Server proxy');
            
            var proxy = getLampaProxy();
            var apiUrl = 'https://rutube.ru/api/play/options/' + videoId + '/?no_404=true&referer=&pver=v2';
            var proxyUrl = proxy + 'v2/' + encodeURIComponent(apiUrl);
            
            AjaxManager.request({
                url: proxyUrl,
                dataType: 'json',
                timeout: CONFIG.STREAM_TIMEOUT,
                success: function(data) {
                    if (data && data.video_balancer && data.video_balancer.m3u8) {
                        Diag.add('STREAM', 'Server proxy SUCCESS!');
                        callback({ m3u8: data.video_balancer.m3u8 });
                    } else {
                        tryRootuM3u8(videoId, callback, groupId);
                    }
                },
                error: function() {
                    Diag.add('STREAM', 'Server proxy failed');
                    tryRootuM3u8(videoId, callback, groupId);
                }
            }, groupId);
        }
        
        // Метод 4: Через rootu.top - у них может быть кэш m3u8
        function tryRootuM3u8(videoId, callback, groupId) {
            Diag.add('STREAM', 'Method 4: Rootu M3U8 cache');
            
            var url = Lampa.Utils.protocol() + 'trailer.rootu.top/m3u8/' + videoId + '.json';
            
            AjaxManager.request({
                url: url,
                dataType: 'json',
                timeout: CONFIG.STREAM_TIMEOUT,
                success: function(data) {
                    if (data && data.m3u8) {
                        Diag.add('STREAM', 'Rootu M3U8 SUCCESS!');
                        callback({ m3u8: data.m3u8 });
                    } else {
                        tryDirectEmbed(videoId, callback, groupId);
                    }
                },
                error: function() {
                    Diag.add('STREAM', 'Rootu M3U8 failed');
                    tryDirectEmbed(videoId, callback, groupId);
                }
            }, groupId);
        }
        
        // Метод 5: Embed URL напрямую (некоторые ТВ поддерживают)
        function tryDirectEmbed(videoId, callback, groupId) {
            Diag.add('STREAM', 'Method 5: Direct embed test');
            
            // Пробуем использовать известный формат m3u8 URL Rutube
            // Rutube использует формат: https://bl.rutube.ru/route/{videoId}.m3u8
            var possibleUrls = [
                'https://bl.rutube.ru/route/' + videoId + '.m3u8',
                'https://bl2.rutube.ru/route/' + videoId + '.m3u8'
            ];
            
            tryM3u8Url(possibleUrls, 0, callback, groupId);
        }
        
        function tryM3u8Url(urls, index, callback, groupId) {
            if (index >= urls.length) {
                Diag.add('STREAM', 'All methods exhausted');
                callback(null);
                return;
            }
            
            var url = urls[index];
            Diag.add('STREAM', 'Testing m3u8 URL', { url: url.substring(0, 50) });
            
            // Проверяем доступность через HEAD запрос или пробуем напрямую
            AjaxManager.request({
                url: url,
                type: 'HEAD',
                timeout: 3000,
                success: function() {
                    Diag.add('STREAM', 'Direct m3u8 accessible!');
                    callback({ m3u8: url });
                },
                error: function() {
                    // Даже если HEAD не работает, всё равно пробуем этот URL
                    // Возможно ТВ сможет его открыть напрямую
                    if (index === 0) {
                        Diag.add('STREAM', 'Trying m3u8 anyway');
                        callback({ m3u8: url, untested: true });
                    } else {
                        tryM3u8Url(urls, index + 1, callback, groupId);
                    }
                }
            }, groupId);
        }
        
        // Главная функция получения stream
        function getStreamUrl(videoId, callback, groupId) {
            Diag.add('STREAM', 'Getting stream', { videoId: videoId });
            tryLampaNetwork(videoId, callback, groupId);
        }

        function searchRootu(movie, isTv, callback, groupId) {
            var tmdbId = movie.id ? ('000000' + movie.id) : '';
            if (tmdbId.length > 7) tmdbId = tmdbId.slice(-Math.max(7, (movie.id + '').length));
            if (!tmdbId || !/^\d+$/.test(tmdbId)) { callback(null); return; }
            var type = isTv ? 'tv' : 'movie';
            
            AjaxManager.request({
                url: rootuApi + type + '/' + tmdbId + '.json',
                dataType: 'json', timeout: CONFIG.ROOTU_TIMEOUT,
                success: function(data) {
                    if (data && data.length && data[0].url) {
                        var videoId = Utils.extractVideoId(data[0].url);
                        if (videoId) { 
                            Diag.add('SEARCH', 'Rootu found', { videoId: videoId });
                            callback({ title: data[0].title, videoId: videoId, source: 'rootu' }); 
                            return; 
                        }
                    }
                    callback(null);
                },
                error: function() { callback(null); }
            }, groupId);
        }
        
        function searchRutube(movie, isTv, callback, groupId) {
            var title = movie.title || movie.name || movie.original_title || movie.original_name || '';
            var year = (movie.release_date || movie.first_air_date || '').substring(0, 4);
            var cleanSearch = Utils.cleanString(title);
            var query = Utils.cleanString([title, year, 'русский трейлер', isTv ? 'сезон 1' : ''].join(' '));
            var url = (searchProxy || '') + 'https://rutube.ru/api/search/video/?query=' + encodeURIComponent(query) + '&format=json';
            
            AjaxManager.request({
                url: url, dataType: 'json', timeout: CONFIG.AJAX_TIMEOUT,
                success: function(data) {
                    if (!data || !data.results || !data.results.length) { callback(null); return; }
                    for (var i = 0; i < data.results.length; i++) {
                        var r = data.results[i];
                        var rTitle = Utils.cleanString(r.title || '');
                        if (!r.embed_url) continue;
                        var isTrailer = rTitle.indexOf('трейлер') >= 0 || rTitle.indexOf('trailer') >= 0 || rTitle.indexOf('тизер') >= 0;
                        if (!isTrailer) continue;
                        if (r.duration && r.duration > CONFIG.MAX_TRAILER_DURATION) continue;
                        if (rTitle.indexOf(cleanSearch) < 0) continue;
                        var videoId = Utils.extractVideoId(r.embed_url || r.video_url);
                        if (videoId) { 
                            Diag.add('SEARCH', 'Rutube found', { videoId: videoId });
                            callback({ title: r.title, videoId: videoId, source: 'rutube' }); 
                            return; 
                        }
                    }
                    callback(null);
                },
                error: function(xhr) {
                    if (xhr.statusText === 'abort') { callback(null); return; }
                    if (!searchProxy && xhr.status === 0) {
                        searchProxy = Lampa.Utils.protocol() + 'rutube-search.root-1a7.workers.dev/';
                        Diag.add('SEARCH', 'Switching to search proxy');
                        searchRutube(movie, isTv, callback, groupId);
                        return;
                    }
                    callback(null);
                }
            }, groupId);
        }
        
        function findTrailer(movie, isTv, callback, groupId) {
            var title = movie.title || movie.name || movie.original_title || movie.original_name || '';
            if (!title || title.length < 2) { callback(null); return; }
            
            Diag.add('SEARCH', 'Looking for trailer', { title: title, id: movie.id });
            
            var cached = TrailerCache.get(movie);
            if (cached && cached.videoId) {
                Diag.add('CACHE', 'Found in cache', { videoId: cached.videoId });
                getStreamUrl(cached.videoId, function(stream) {
                    if (stream && stream.m3u8) {
                        callback({ videoId: cached.videoId, m3u8: stream.m3u8 });
                    } else { callback(null); }
                }, groupId);
                return;
            }
            
            var completed = false;
            var results = { rootu: null, rutube: null };
            var pending = 2;
            
            function checkComplete() {
                pending--;
                if (!completed && results.rootu && results.rootu.videoId) {
                    completed = true;
                    fetchStreamAndReturn(results.rootu);
                    return;
                }
                if (pending === 0 && !completed) {
                    if (results.rutube && results.rutube.videoId) {
                        completed = true;
                        fetchStreamAndReturn(results.rutube);
                    } else {
                        Diag.add('SEARCH', 'No trailer found');
                        TrailerCache.set(movie, { videoId: null });
                        callback(null);
                    }
                }
            }
            
            function fetchStreamAndReturn(result) {
                TrailerCache.set(movie, { videoId: result.videoId, title: result.title });
                getStreamUrl(result.videoId, function(stream) {
                    if (stream && stream.m3u8) {
                        Diag.add('STREAM', 'Got m3u8!', { url: stream.m3u8.substring(0, 60) });
                        callback({ videoId: result.videoId, m3u8: stream.m3u8, untested: stream.untested });
                    } else { 
                        Diag.add('STREAM', 'Failed to get stream');
                        callback(null); 
                    }
                }, groupId);
            }
            
            searchRootu(movie, isTv, function(result) { results.rootu = result; checkComplete(); }, groupId);
            searchRutube(movie, isTv, function(result) { results.rutube = result; checkComplete(); }, groupId);
        }
        
        return { findTrailer: findTrailer, getStreamUrl: getStreamUrl };
    })();

    var PrefetchManager = {
        _pending: {}, _prefetched: {},
        prefetch: function(movie, isTv) {
            if (!CONFIG.PREFETCH_ENABLED || !movie || !movie.id) return;
            var key = Utils.getMovieCacheKey(movie);
            if (this._prefetched[key] || this._pending[key]) return;
            var cached = TrailerCache.get(movie);
            if (cached && cached.videoId) { this._prefetched[key] = true; return; }
            this._pending[key] = true;
            var self = this;
            RutubeAPI.findTrailer(movie, isTv, function(result) {
                delete self._pending[key];
                if (result && result.m3u8) self._prefetched[key] = true;
            }, 'prefetch_' + key);
        },
        cancel: function(movie) {
            if (!movie) return;
            var key = Utils.getMovieCacheKey(movie);
            if (this._pending[key]) { AjaxManager.abortGroup('prefetch_' + key); delete this._pending[key]; }
        }
    };

    var RatingsRenderer = {
        render: function(container, card) {
            var $container = $(container);
            $container.find('.cardify-ratings-list').remove();
            var ratings = [];
            if (card.vote_average > 0) ratings.push({ name: 'TMDB', value: card.vote_average });
            var kp = card.kp_rating || card.rating_kinopoisk || (card.ratings && card.ratings.kp);
            if (kp && kp > 0) ratings.push({ name: 'KP', value: kp });
            var imdb = card.imdb_rating || (card.ratings && card.ratings.imdb);
            if (imdb && imdb > 0) ratings.push({ name: 'IMDb', value: imdb });
            var fireCount = card.reactions ? (card.reactions['0'] || card.reactions['fire'] || card.reactions['like'] || 0) : 0;
            if (ratings.length === 0 && fireCount === 0) return;
            var html = '<div class="cardify-ratings-list">';
            ratings.forEach(function(r) {
                html += '<div class="cardify-rate-item"><span class="cardify-rate-icon">' + r.name + '</span><span class="cardify-rate-value">' + parseFloat(r.value).toFixed(1) + '</span></div>';
            });
            if (fireCount > 0) {
                html += '<div class="cardify-rate-item reaction"><svg width="12" height="14" viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right:0.3em;margin-bottom:2px;"><path d="M6 0C6 0 0 2.91667 0 8.16667C0 11.3887 2.68629 14 6 14C9.31371 14 12 11.3887 12 8.16667C12 2.91667 6 0 6 0ZM6 12.25C4.39167 12.25 3.08333 10.9417 3.08333 9.33333C3.08333 8.35625 3.63417 7.48417 4.445 7.00583C4.24667 7.5075 4.39833 8.16667 4.83333 8.16667C5.26833 8.16667 5.625 7.72625 5.5125 7.2275C5.355 6.52458 5.7575 5.64958 6.4575 5.25C6.18333 6.125 6.78417 7 7.58333 7C7.9975 7 8.365 7.21875 8.58083 7.55417C8.79958 8.085 8.91667 8.68292 8.91667 9.33333C8.91667 10.9417 7.60833 12.25 6 12.25Z" fill="white"/></svg><span class="cardify-rate-value">' + fireCount + '</span></div>';
            }
            html += '</div>';
            var $rateLine = $container.find('.full-start-new__rate-line');
            if ($rateLine.length) $rateLine.before(html);
            else $container.find('.cardify__right').append(html);
        }
    };

    var BackgroundTrailer = function(render, trailerData, onDestroy) {
        var self = this;
        this.destroyed = false;
        this.hls = null;
        this.groupId = Utils.generateId('trailer');
        
        Diag.add('VIDEO', 'Creating player', { videoId: trailerData.videoId, hasM3u8: !!trailerData.m3u8, untested: trailerData.untested });
        
        this.$render = $(render);
        this.$background = this.$render.find('.full-start__background');
        
        this.$html = $('<div class="cardify-bg-video"><video class="cardify-bg-video__player" muted autoplay playsinline loop preload="auto"></video><div class="cardify-bg-video__overlay"></div></div>');
        
        this.videoElement = this.$html.find('video')[0];
        this.videoElement.muted = true;
        this.videoElement.setAttribute('muted', '');
        this.videoElement.setAttribute('playsinline', '');
        this.videoElement.setAttribute('webkit-playsinline', '');
        this.videoElement.setAttribute('crossorigin', 'anonymous');
        
        this.$background.after(this.$html);
        
        this._boundUpdateScale = this._updateScale.bind(this);
        this._boundOnMetadata = this._onMetadata.bind(this);
        this._boundOnPlaying = this._onPlaying.bind(this);
        this._boundOnError = this._onError.bind(this);
        this._boundOnCanPlay = this._onCanPlay.bind(this);
        this._onDestroy = onDestroy;
        
        window.addEventListener('resize', this._boundUpdateScale);
        
        if (trailerData.m3u8) {
            this._loadStream(trailerData.m3u8);
        } else {
            RutubeAPI.getStreamUrl(trailerData.videoId, function(stream) {
                if (self.destroyed) return;
                if (!stream || !stream.m3u8) { 
                    Diag.add('VIDEO', 'No stream, destroying');
                    self.destroy(); 
                    return; 
                }
                self._loadStream(stream.m3u8);
            }, this.groupId);
        }
    };
    
    BackgroundTrailer.prototype._updateScale = function() {
        if (this.destroyed || !this.videoElement) return;
        var screenRatio = window.innerWidth / window.innerHeight;
        var scale = CONFIG.SCALE_BASE;
        if (screenRatio > 1.8) scale = Math.max(CONFIG.SCALE_MIN, CONFIG.SCALE_BASE - (screenRatio - CONFIG.ASPECT_THRESHOLD));
        this.videoElement.style.transform = 'scale(' + scale + ')';
    };
    
    BackgroundTrailer.prototype._loadStream = function(m3u8Url) {
        var self = this;
        var video = this.videoElement;
        
        Diag.add('VIDEO', 'Loading stream', { url: m3u8Url.substring(0, 60) });
        
        var nativeSupport = video.canPlayType('application/vnd.apple.mpegurl');
        Diag.add('VIDEO', 'Native HLS', { support: nativeSupport || 'none' });
        
        // Vidaa поддерживает native HLS - пробуем сначала его
        if (nativeSupport && nativeSupport !== '') {
            Diag.add('VIDEO', 'Using NATIVE HLS');
            video.src = m3u8Url;
            this._setupVideoEvents();
            setTimeout(function() { if (!self.destroyed) self._tryPlay(); }, 200);
            return;
        }
        
        hlsReady.then(function(loaded) {
            if (self.destroyed) return;
            
            var hlsSupported = loaded && typeof Hls !== 'undefined' && Hls.isSupported();
            Diag.add('VIDEO', 'HLS.js', { loaded: loaded, supported: hlsSupported });
            
            if (hlsSupported) {
                Diag.add('VIDEO', 'Using HLS.JS');
                
                self.hls = new Hls({ 
                    autoStartLoad: true,
                    startLevel: CONFIG.HLS_START_LEVEL,
                    maxBufferLength: CONFIG.HLS_MAX_BUFFER,
                    maxMaxBufferLength: 30,
                    lowLatencyMode: true,
                    backBufferLength: 0,
                    xhrSetup: function(xhr, url) {
                        // Пробуем без credentials для CORS
                        xhr.withCredentials = false;
                    }
                });
                
                self.hls.on(Hls.Events.MANIFEST_PARSED, function(event, data) {
                    Diag.add('VIDEO', 'Manifest parsed', { levels: data.levels.length });
                    self._tryPlay();
                });
                
                self.hls.on(Hls.Events.ERROR, function(event, data) {
                    Diag.add('VIDEO', 'HLS error', { type: data.type, fatal: data.fatal, details: data.details });
                    if (data.fatal) {
                        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                            Diag.add('VIDEO', 'Network error - trying recovery');
                            self.hls.startLoad();
                        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                            Diag.add('VIDEO', 'Media error - trying recovery');
                            self.hls.recoverMediaError();
                        } else {
                            Diag.add('VIDEO', 'Fatal error - destroying');
                            self.destroy();
                        }
                    }
                });
                
                self.hls.loadSource(m3u8Url);
                self.hls.attachMedia(video);
                self._setupVideoEvents();
            } else {
                // Fallback - пробуем напрямую
                Diag.add('VIDEO', 'Direct source fallback');
                video.src = m3u8Url;
                self._setupVideoEvents();
                setTimeout(function() { if (!self.destroyed) self._tryPlay(); }, 200);
            }
        });
    };
    
    BackgroundTrailer.prototype._setupVideoEvents = function() {
        var video = this.videoElement;
        video.addEventListener('loadedmetadata', this._boundOnMetadata);
        video.addEventListener('canplay', this._boundOnCanPlay);
        video.addEventListener('playing', this._boundOnPlaying);
        video.addEventListener('error', this._boundOnError);
    };
    
    BackgroundTrailer.prototype._removeVideoEvents = function() {
        if (!this.videoElement) return;
        var video = this.videoElement;
        video.removeEventListener('loadedmetadata', this._boundOnMetadata);
        video.removeEventListener('canplay', this._boundOnCanPlay);
        video.removeEventListener('playing', this._boundOnPlaying);
        video.removeEventListener('error', this._boundOnError);
    };
    
    BackgroundTrailer.prototype._onMetadata = function() {
        if (this.destroyed) return;
        Diag.add('VIDEO', 'Metadata loaded', { 
            duration: Math.round(this.videoElement.duration),
            size: this.videoElement.videoWidth + 'x' + this.videoElement.videoHeight
        });
        var video = this.videoElement;
        if (video.duration > CONFIG.VIDEO_MIN_DURATION_FOR_SKIP) {
            video.currentTime = CONFIG.VIDEO_SKIP_SECONDS;
        }
        this._updateScale();
    };
    
    BackgroundTrailer.prototype._onCanPlay = function() {
        if (this.destroyed) return;
        Diag.add('VIDEO', 'CanPlay event');
        this._tryPlay();
    };
    
    BackgroundTrailer.prototype._onPlaying = function() {
        if (this.destroyed) return;
        Diag.add('VIDEO', '*** PLAYING! ***');
        this.$html.addClass('cardify-bg-video--visible');
        this.$background.addClass('cardify-bg-hidden');
    };
    
    BackgroundTrailer.prototype._onError = function(e) {
        var video = this.videoElement;
        var errorDetails = {
            code: video.error ? video.error.code : 'none',
            message: video.error ? video.error.message : 'none',
            networkState: video.networkState,
            readyState: video.readyState
        };
        Diag.add('VIDEO', 'ERROR', errorDetails);
    };
    
    BackgroundTrailer.prototype._tryPlay = function() {
        var self = this;
        var video = this.videoElement;
        if (!video || this.destroyed) return;
        
        Diag.add('VIDEO', 'Attempting play...', { paused: video.paused, readyState: video.readyState });
        
        video.muted = true;
        video.volume = 0;
        
        var playPromise = video.play();
        if (playPromise !== undefined) {
            playPromise.then(function() {
                Diag.add('VIDEO', 'Play SUCCESS');
            }).catch(function(error) {
                Diag.add('VIDEO', 'Play FAILED', { name: error.name, message: error.message });
                // Повторная попытка
                setTimeout(function() {
                    if (self.destroyed) return;
                    video.muted = true;
                    video.play().catch(function(e) {
                        Diag.add('VIDEO', 'Retry FAILED', { message: e.message });
                    });
                }, 1000);
            });
        }
    };
    
    BackgroundTrailer.prototype.destroy = function() {
        if (this.destroyed) return;
        this.destroyed = true;
        Diag.add('VIDEO', 'Destroying');
        AjaxManager.abortGroup(this.groupId);
        window.removeEventListener('resize', this._boundUpdateScale);
        this._removeVideoEvents();
        if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
        if (this.videoElement) {
            try { this.videoElement.pause(); this.videoElement.src = ''; this.videoElement.load(); } catch (e) {}
            this.videoElement = null;
        }
        if (this.$background) this.$background.removeClass('cardify-bg-hidden');
        if (this.$html) { this.$html.remove(); this.$html = null; }
        if (typeof this._onDestroy === 'function') this._onDestroy();
    };

    var OriginalTitle = (function() {
        var storageKey = "cardify_title_cache";
        var titleCache = null;
        function loadCache() { if (titleCache === null) titleCache = Lampa.Storage.get(storageKey) || {}; return titleCache; }
        function cleanOldCache() {
            var cache = loadCache(); var now = Date.now(); var changed = false;
            for (var id in cache) { if (cache.hasOwnProperty(id) && now - cache[id].timestamp > CONFIG.CACHE_TTL_MS) { delete cache[id]; changed = true; } }
            if (changed) DebouncedStorage.set(storageKey, cache);
        }
        function fetchTitles(card) {
            return new Promise(function(resolve) {
                var cache = loadCache();
                var orig = card.original_title || card.original_name || '';
                var alt = (card.alternative_titles && (card.alternative_titles.titles || card.alternative_titles.results)) || [];
                var translitObj = alt.find(function(t) { return t.type === "Transliteration" || t.type === "romaji"; });
                var translit = translitObj ? (translitObj.title || (translitObj.data && (translitObj.data.title || translitObj.data.name)) || '') : '';
                var ruObj = alt.find(function(t) { return t.iso_3166_1 === "RU"; }); var ru = ruObj ? ruObj.title : '';
                var enObj = alt.find(function(t) { return t.iso_3166_1 === "US"; }); var en = enObj ? enObj.title : '';
                var cachedData = cache[card.id];
                if (cachedData && Date.now() - cachedData.timestamp < CONFIG.CACHE_TTL_MS) {
                    ru = ru || cachedData.ru || ''; en = en || cachedData.en || ''; translit = translit || cachedData.translit || '';
                }
                if (!ru || !en || !translit) {
                    var type = card.first_air_date ? "tv" : "movie";
                    Lampa.Api.sources.tmdb.get(type + "/" + card.id + "?append_to_response=translations", {},
                        function(data) {
                            try {
                                var tr = (data.translations && data.translations.translations) || [];
                                var translitData = tr.find(function(t) { return t.type === "Transliteration" || t.type === "romaji"; });
                                if (translitData) translit = translitData.title || (translitData.data && (translitData.data.title || translitData.data.name)) || translit;
                                if (!ru) { var ruData = tr.find(function(t) { return t.iso_3166_1 === "RU" || t.iso_639_1 === "ru"; }); if (ruData && ruData.data) ru = ruData.data.title || ruData.data.name || ''; }
                                if (!en) { var enData = tr.find(function(t) { return t.iso_3166_1 === "US" || t.iso_639_1 === "en"; }); if (enData && enData.data) en = enData.data.title || enData.data.name || ''; }
                                cache[card.id] = { ru: ru, en: en, translit: translit, timestamp: Date.now() };
                                DebouncedStorage.set(storageKey, cache);
                            } catch (e) {}
                            resolve({ original: orig, ru: ru, en: en, translit: translit });
                        },
                        function() { resolve({ original: orig, ru: ru, en: en, translit: translit }); }
                    );
                } else { resolve({ original: orig, ru: ru, en: en, translit: translit }); }
            });
        }
        function render(container, titles) {
            var $container = $(container); $container.find('.cardify-original-titles').remove();
            var items = [];
            if (titles.original) items.push({ title: titles.original, label: 'Original' });
            if (titles.translit && titles.translit !== titles.original && titles.translit !== titles.en) items.push({ title: titles.translit, label: 'Translit' });
            if (!items.length) return;
            var html = '<div class="cardify-original-titles">';
            items.forEach(function(item) { html += '<div class="cardify-original-titles__item"><span class="cardify-original-titles__text">' + item.title + '</span><span class="cardify-original-titles__label">' + item.label + '</span></div>'; });
            html += '</div>';
            var $details = $container.find('.full-start-new__details');
            if ($details.length) $details.after(html); else $container.find('.full-start-new__title').after(html);
        }
        return { init: cleanOldCache, fetch: fetchTitles, render: render };
    })();

    var CARDIFY_CSS = '.cardify .full-start-new__body{height:80vh}.cardify .full-start-new__right{display:flex;align-items:flex-end}.cardify .full-start-new__title{text-shadow:0 0 10px rgba(0,0,0,0.8);font-size:5em!important;line-height:1.1!important;margin-bottom:0.15em;position:relative;z-index:2}.cardify .full-start-new__details{margin-bottom:0.5em;font-size:1.3em;opacity:0.9;text-shadow:0 1px 2px rgba(0,0,0,0.8);position:relative;z-index:2}.cardify .full-start-new__head{margin-bottom:0.3em;position:relative;z-index:2}.cardify img.full--logo,.cardify .full-start__title-img{max-height:24em!important;max-width:90%!important;height:auto!important;width:auto!important;object-fit:contain!important}.cardify__left{flex-grow:1;max-width:70%;position:relative;z-index:2}.cardify__right{display:flex;align-items:center;flex-shrink:0;position:relative;z-index:2}.cardify__background{left:0;transition:opacity 1s ease}.cardify__background.cardify-bg-hidden{opacity:0!important}.cardify .full-start-new__reactions{display:none!important}.cardify .full-start-new__rate-line{margin:0 0 0 1em;display:flex;align-items:center}.cardify-bg-video{position:absolute;top:-20%;left:0;right:0;bottom:-20%;z-index:0;opacity:0;transition:opacity 1.5s ease;overflow:hidden;pointer-events:none}.cardify-bg-video--visible{opacity:1}.cardify-bg-video__player{width:100%;height:100%;object-fit:cover;transition:transform 1s ease;will-change:transform;filter:brightness(0.85) saturate(1.1)}.cardify-bg-video__overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(90deg,rgba(0,0,0,0.95) 0%,rgba(0,0,0,0.5) 40%,transparent 100%),linear-gradient(to top,rgba(0,0,0,0.9) 0%,transparent 30%);pointer-events:none}.cardify-ratings-list{display:flex;gap:0.8em;align-items:center}.cardify-rate-item{display:flex;flex-direction:row;align-items:center;gap:0.4em;border:2px solid rgba(255,255,255,0.5);border-radius:6px;padding:0.4em 0.8em;background:transparent;color:#fff}.cardify-rate-icon{font-size:0.9em;opacity:0.8;font-weight:normal;margin:0}.cardify-rate-value{font-size:1.1em;font-weight:bold;color:#fff!important}.cardify-rate-item.reaction{border-color:rgba(255,255,255,0.5)}.cardify-original-titles{margin-bottom:1em;display:flex;flex-direction:column;gap:0.3em;position:relative;z-index:2}.cardify-original-titles__item{display:flex;align-items:center;gap:0.8em;font-size:1.4em;opacity:0.9}.cardify-original-titles__text{color:#fff;text-shadow:0 1px 3px rgba(0,0,0,0.8)}.cardify-original-titles__label{font-size:0.7em;padding:0.2em 0.5em;background:rgba(255,255,255,0.2);border-radius:0.3em;text-transform:uppercase}.cardify .original_title{display:none!important}';

    function startPlugin() {
        Diag.add('INIT', 'Starting', { version: PLUGIN_VERSION });
        
        // Проверяем доступные API Lampa
        Diag.add('INIT', 'Lampa APIs', {
            Network: typeof Lampa.Network !== 'undefined',
            Reguest: typeof Lampa.Reguest !== 'undefined',
            Utils: typeof Lampa.Utils !== 'undefined'
        });
        
        OriginalTitle.init();

        Lampa.Lang.add({
            cardify_enable_trailer: { ru: 'Фоновый трейлер', en: 'Background trailer', uk: 'Фоновий трейлер' },
            cardify_show_original_title: { ru: 'Оригинальное название', en: 'Original title', uk: 'Оригінальна назва' },
            cardify_prefetch: { ru: 'Предзагрузка трейлеров', en: 'Prefetch trailers', uk: 'Передзавантаження трейлерів' }
        });

        Lampa.Template.add('full_start_new', '<div class="full-start-new cardify"><div class="full-start-new__body"><div class="full-start-new__left hide"><div class="full-start-new__poster"><img class="full-start-new__img full--poster" /></div></div><div class="full-start-new__right"><div class="cardify__left"><div class="full-start-new__head"></div><div class="full-start-new__title">{title}</div><div class="full-start-new__details"></div><div class="full-start-new__buttons"><div class="full-start__button selector button--play"><svg width="28" height="29" viewBox="0 0 28 29" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="14" cy="14.5" r="13" stroke="currentColor" stroke-width="2.7"/><path d="M18.0739 13.634C18.7406 14.0189 18.7406 14.9811 18.0739 15.366L11.751 19.0166C11.0843 19.4015 10.251 18.9204 10.251 18.1506L10.251 10.8494C10.251 10.0796 11.0843 9.5985 11.751 9.9834L18.0739 13.634Z" fill="currentColor"/></svg><span>#{title_watch}</span></div><div class="full-start__button selector button--book"><svg width="21" height="32" viewBox="0 0 21 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 1.5H19C19.2761 1.5 19.5 1.72386 19.5 2V27.9618C19.5 28.3756 19.0261 28.6103 18.697 28.3595L12.6212 23.7303C11.3682 22.7757 9.63183 22.7757 8.37885 23.7303L2.30302 28.3595C1.9739 28.6103 1.5 28.3756 1.5 27.9618V2C1.5 1.72386 1.72386 1.5 2 1.5Z" stroke="currentColor" stroke-width="2.5"/></svg><span>#{settings_input_links}</span></div><div class="full-start__button selector button--reaction"><svg width="38" height="34" viewBox="0 0 38 34" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M37.208 10.97L12.07 0.11C11.72-0.04 11.32-0.04 10.97 0.11C10.63 0.25 10.35 0.53 10.2 0.88L0.11 25.25C0.04 25.42 0 25.61 0 25.8C0 25.98 0.04 26.17 0.11 26.34C0.18 26.51 0.29 26.67 0.42 26.8C0.55 26.94 0.71 27.04 0.88 27.11L17.25 33.89C17.59 34.04 17.99 34.04 18.34 33.89L29.66 29.2C29.83 29.13 29.99 29.03 30.12 28.89C30.25 28.76 30.36 28.6 30.43 28.43L37.21 12.07C37.28 11.89 37.32 11.71 37.32 11.52C37.32 11.33 37.28 11.15 37.21 10.97ZM20.43 29.94L21.88 26.43L25.39 27.89L20.43 29.94ZM28.34 26.02L21.65 23.25C21.3 23.11 20.91 23.11 20.56 23.25C20.21 23.4 19.93 23.67 19.79 24.02L17.02 30.71L3.29 25.02L12.29 3.29L34.03 12.29L28.34 26.02Z" fill="currentColor"/></svg><span>#{title_reactions}</span></div><div class="full-start__button selector button--subscribe hide"></div><div class="full-start__button selector button--options"><svg width="38" height="10" viewBox="0 0 38 10" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="4.89" cy="4.99" r="4.75" fill="currentColor"/><circle cx="18.97" cy="4.99" r="4.75" fill="currentColor"/><circle cx="33.06" cy="4.99" r="4.75" fill="currentColor"/></svg></div></div></div><div class="cardify__right"><div class="full-start-new__reactions selector"><div>#{reactions_none}</div></div><div class="full-start-new__rate-line"><div class="full-start__pg hide"></div><div class="full-start__status hide"></div></div></div></div></div><div class="hide buttons--container"><div class="full-start__button view--torrent hide"></div><div class="full-start__button selector view--trailer"></div></div></div>');

        if (!document.getElementById('cardify-css')) {
            var style = document.createElement('style');
            style.id = 'cardify-css';
            style.textContent = CARDIFY_CSS;
            document.head.appendChild(style);
        }

        Lampa.SettingsApi.addComponent({ component: 'cardify', icon: '<svg width="36" height="28" viewBox="0 0 36 28" fill="none"><rect x="1.5" y="1.5" width="33" height="25" rx="3.5" stroke="white" stroke-width="3"/></svg>', name: 'Cardify v' + PLUGIN_VERSION });
        Lampa.SettingsApi.addParam({ component: 'cardify', param: { name: 'cardify_run_trailers', type: 'trigger', default: true }, field: { name: Lampa.Lang.translate('cardify_enable_trailer') } });
        Lampa.SettingsApi.addParam({ component: 'cardify', param: { name: 'cardify_prefetch', type: 'trigger', default: true }, field: { name: Lampa.Lang.translate('cardify_prefetch') } });
        Lampa.SettingsApi.addParam({ component: 'cardify', param: { name: 'cardify_show_original_title', type: 'trigger', default: true }, field: { name: Lampa.Lang.translate('cardify_show_original_title') } });

        var activeTrailers = {};
        var prefetchTimeout = null;
        var lastFocusedCard = null;

        Lampa.Listener.follow('hover', function(e) {
            if (e.type === 'enter' && e.card) {
                if (prefetchTimeout) clearTimeout(prefetchTimeout);
                if (lastFocusedCard && lastFocusedCard.id !== e.card.id) PrefetchManager.cancel(lastFocusedCard);
                lastFocusedCard = e.card;
                if (Lampa.Storage.field('cardify_prefetch') !== false && Lampa.Storage.field('cardify_run_trailers') !== false) {
                    prefetchTimeout = setTimeout(function() {
                        var isTv = !!(e.card.first_air_date || e.card.media_type === 'tv');
                        PrefetchManager.prefetch(e.card, isTv);
                    }, CONFIG.PREFETCH_DELAY);
                }
            }
        });

        Lampa.Listener.follow('full', function(e) {
            if (e.type === 'complite') {
                var render = e.object.activity.render();
                var activityId = e.object.activity.id || Utils.generateId('activity');
                
                Diag.add('CARD', 'Opened', { id: e.data.movie ? e.data.movie.id : 'unknown' });
                
                render.find('.full-start__background').addClass('cardify__background');
                if (e.data.movie) RatingsRenderer.render(render, e.data.movie);
                if (Lampa.Storage.field('cardify_show_original_title') !== false && e.data.movie) {
                    OriginalTitle.fetch(e.data.movie).then(function(titles) { OriginalTitle.render(render.find('.cardify__left'), titles); }).catch(function() {});
                }
                if (Lampa.Storage.field('cardify_run_trailers') !== false && e.data.movie) {
                    var movie = e.data.movie;
                    var isTv = !!(e.object.method && e.object.method === 'tv');
                    var groupId = 'trailer_' + activityId;
                    var startTime = Date.now();
                    
                    RutubeAPI.findTrailer(movie, isTv, function(result) {
                        var elapsed = Date.now() - startTime;
                        Diag.add('SEARCH', 'Completed', { ms: elapsed, found: !!result });
                        
                        if (result && result.m3u8) {
                            if (activeTrailers[activityId]) activeTrailers[activityId].destroy();
                            activeTrailers[activityId] = new BackgroundTrailer(render, result, function() { delete activeTrailers[activityId]; });
                        }
                    }, groupId);
                }
            }
            if (e.type === 'destroy') {
                Diag.add('CARD', 'Closed');
                var activityId = e.object.activity.id || 0;
                AjaxManager.abortGroup('trailer_' + activityId);
                if (activeTrailers[activityId]) { activeTrailers[activityId].destroy(); delete activeTrailers[activityId]; }
            }
        });

        window.addEventListener('beforeunload', function() {
            DebouncedStorage.flush();
            AjaxManager.abortAll();
            Object.keys(activeTrailers).forEach(function(id) { activeTrailers[id].destroy(); });
        });

        Diag.add('INIT', 'Ready!');
    }

    if (window.appready) startPlugin();
    else Lampa.Listener.follow('app', function(e) { if (e.type === 'ready') startPlugin(); });
})();
