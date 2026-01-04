(function() {
    'use strict';

    var CONFIG = {
        name: 'KinoPub',
        version: '1.0.1',
        apiBase: 'https://api.service-kp.com/v1',
        token: '1ksgubh1qkewyq3u4z65bpnwn9eshhn2',
        protocol: 'hls4',
        quality: null
    };

    function getToken() {
        return CONFIG.token;
    }

    function getProtocol() {
        return CONFIG.protocol;
    }

    function apiRequest(path, params) {
        return new Promise(function(resolve, reject) {
            var token = getToken();
            if (!token) {
                reject({ error: 'no_token' });
                return;
            }

            var url = CONFIG.apiBase + path;

            if (params) {
                var query = Object.keys(params).map(function(key) {
                    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
                }).join('&');
                url += '?' + query;
            }

            console.log('KinoPub API Request:', url);

            var network = new Lampa.Reguest();

            network.native(url, function(response) {
                console.log('KinoPub API Response:', response);
                if (typeof response === 'string') {
                    try { response = JSON.parse(response); } catch(e) {}
                }
                resolve(response);
            }, function(err) {
                console.log('KinoPub API Error:', err);
                reject(err);
            }, false, {
                headers: { 'Authorization': 'Bearer ' + token },
                timeout: 15000
            });
        });
    }

    function searchContent(query) {
        return apiRequest('/items/search', { q: query });
    }

    function getItem(id) {
        return apiRequest('/items/' + id);
    }

    function extractVideoUrl(files) {
        if (!files || !files.length) return null;

        var protocol = getProtocol();
        var allQualities = {};

        files.forEach(function(file) {
            var url = file.url && (file.url[protocol] || file.url.hls4 || file.url.hls || file.url.http);
            if (url) allQualities[file.quality] = url;
        });

        var sorted = files.slice().sort(function(a, b) {
            return (b.quality_id || 0) - (a.quality_id || 0);
        });

        var best = sorted.find(function(f) {
            return f.url && (f.url[protocol] || f.url.hls4 || f.url.hls || f.url.http);
        });

        if (!best) return null;

        return {
            url: best.url[protocol] || best.url.hls4 || best.url.hls || best.url.http,
            quality: best.quality,
            qualities: allQualities
        };
    }

    function buildFileList(item) {
        console.log('KinoPub buildFileList:', item);
        var files = [];

        if (item.videos && item.videos.length) {
            console.log('KinoPub: Found videos:', item.videos.length);
            item.videos.forEach(function(video) {
                var extracted = extractVideoUrl(video.files);
                console.log('KinoPub: Extracted video:', extracted);
                if (!extracted) return;

                files.push({
                    title: video.title || item.title,
                    quality: extracted.quality,
                    url: extracted.url,
                    qualitys: extracted.qualities,
                    subtitles: (video.subtitles || []).map(function(s) {
                        return { label: s.lang, url: s.url };
                    }),
                    method: 'play',
                    voice_name: item.voice || ''
                });
            });
        }

        if (item.seasons && item.seasons.length) {
            console.log('KinoPub: Found seasons:', item.seasons.length);
            item.seasons.forEach(function(season) {
                (season.episodes || []).forEach(function(episode) {
                    var extracted = extractVideoUrl(episode.files);
                    if (!extracted) return;

                    files.push({
                        title: episode.title,
                        season: season.number,
                        episode: episode.number,
                        quality: extracted.quality,
                        url: extracted.url,
                        qualitys: extracted.qualities,
                        subtitles: (episode.subtitles || []).map(function(s) {
                            return { label: s.lang, url: s.url };
                        }),
                        method: 'play',
                        voice_name: item.voice || ''
                    });
                });
            });
        }

        console.log('KinoPub: Total files:', files.length);
        return files;
    }

    function KinoPubComponent(object) {
        var network = new Lampa.Reguest();
        var scroll = new Lampa.Scroll({ mask: true, over: true });
        var files = new Lampa.Explorer(object);
        var filter = new Lampa.Filter(object);

        var last = null;
        var initialized = false;
        var videoFiles = [];
        var filterData = { season: [] };
        var currentSeason = 0;

        this.initialize = function() {
            console.log('KinoPub: Initialize');
            this.loading(true);
            this.search();
        };

        this.search = function() {
            var self = this;
            var movie = object.movie;
            var query = movie.title || movie.name || movie.original_title || movie.original_name;

            console.log('KinoPub: Searching for:', query);

            searchContent(query).then(function(response) {
                console.log('KinoPub: Search response:', response);
                if (response && response.items && response.items.length) {
                    console.log('KinoPub: Found items:', response.items.length);
                    var found = self.findBestMatch(response.items, movie);
                    if (found) {
                        console.log('KinoPub: Best match:', found);
                        self.loadItem(found.id);
                    } else {
                        console.log('KinoPub: No exact match, showing results');
                        self.showSearchResults(response.items);
                    }
                } else {
                    console.log('KinoPub: No results');
                    self.showMessage('Ничего не найдено', 'Поиск: ' + query);
                }
            }).catch(function(err) {
                console.log('KinoPub: Search error:', err);
                self.showMessage('Ошибка поиска', err.message || '');
            });
        };

        this.findBestMatch = function(items, movie) {
            var year = parseInt((movie.release_date || movie.first_air_date || '0').substring(0, 4));
            var title = (movie.title || movie.name || '').toLowerCase();
            var originalTitle = (movie.original_title || movie.original_name || '').toLowerCase();

            return items.find(function(item) {
                var itemTitle = (item.title || '').toLowerCase();
                var itemYear = item.year;
                var yearMatch = !year || !itemYear || Math.abs(year - itemYear) <= 1;
                var titleMatch = itemTitle === title || itemTitle === originalTitle;
                return yearMatch && titleMatch;
            });
        };

        this.showSearchResults = function(items) {
            var self = this;
            console.log('KinoPub: showSearchResults', items.length);
            scroll.clear();

            items.slice(0, 10).forEach(function(item) {
                var html = $('<div class="selector kinopub-item"></div>');
                html.append('<div class="kinopub-item__title">' + item.title + '</div>');
                html.append('<div class="kinopub-item__info">' + (item.year || '') + ' • ' + (item.type || '') + '</div>');

                html.on('hover:enter', function() {
                    self.loadItem(item.id);
                }).on('hover:focus', function(e) {
                    last = e.target;
                    scroll.update($(e.target), true);
                });

                scroll.append(html);
            });

            this.loading(false);
            Lampa.Controller.enable('content');
        };

        this.loadItem = function(id) {
            var self = this;
            console.log('KinoPub: loadItem', id);
            scroll.clear();

            getItem(id).then(function(response) {
                console.log('KinoPub: Item response:', response);
                if (response && response.item) {
                    videoFiles = buildFileList(response.item);
                    if (videoFiles.length) {
                        self.buildFilters();
                        self.display();
                    } else {
                        self.showMessage('Видео не найдено', '');
                    }
                } else {
                    self.showMessage('Контент не найден', '');
                }
            }).catch(function(err) {
                console.log('KinoPub: Load error:', err);
                self.showMessage('Ошибка загрузки', err.message || '');
            });
        };

        this.buildFilters = function() {
            filterData.season = [];
            var seasons = {};

            videoFiles.forEach(function(f) {
                if (f.season) seasons[f.season] = true;
            });

            var seasonNumbers = Object.keys(seasons).map(Number).sort(function(a, b) { return a - b; });

            if (seasonNumbers.length > 1) {
                filterData.season = seasonNumbers.map(function(n) {
                    return { title: 'Сезон ' + n, number: n };
                });
                currentSeason = seasonNumbers[0];
            }
        };

        this.display = function() {
            var self = this;
            console.log('KinoPub: display, files:', videoFiles.length);
            scroll.clear();

            var filtered = videoFiles;
            if (currentSeason && filterData.season.length) {
                filtered = videoFiles.filter(function(f) {
                    return f.season === currentSeason;
                });
            }

            console.log('KinoPub: filtered files:', filtered.length);

            filtered.forEach(function(file) {
                var title = file.title;
                if (file.season && file.episode) {
                    title = 'S' + file.season + ':E' + file.episode + ' ' + file.title;
                }

                var html = $('<div class="selector kinopub-item"></div>');
                html.append('<div class="kinopub-item__title">' + title + '</div>');
                html.append('<div class="kinopub-item__info"><span class="kinopub-item__quality">' + (file.quality || '') + '</span></div>');

                html.on('hover:enter', function() {
                    self.play(file, filtered);
                }).on('hover:focus', function(e) {
                    last = e.target;
                    scroll.update($(e.target), true);
                });

                scroll.append(html);
            });

            this.updateFilter();
            this.loading(false);
            Lampa.Controller.enable('content');
        };

        this.play = function(file, playlist) {
            console.log('KinoPub: play', file);
            var lampaPlaylist = playlist.map(function(f) {
                var title = f.title;
                if (f.season && f.episode) {
                    title = '[S' + f.season + '/E' + f.episode + '] ' + f.title;
                }
                return {
                    title: title,
                    url: f.url,
                    quality: f.qualitys,
                    subtitles: f.subtitles
                };
            });

            var currentIndex = playlist.indexOf(file);
            var current = lampaPlaylist[currentIndex];

            if (current.url) {
                if (object.movie.id) Lampa.Favorite.add('history', object.movie, 100);
                current.playlist = lampaPlaylist;
                Lampa.Player.play(current);
                Lampa.Player.playlist(lampaPlaylist);
            } else {
                Lampa.Noty.show('Ссылка не найдена');
            }
        };

        this.updateFilter = function() {
            var self = this;

            if (filterData.season.length > 1) {
                filter.set('filter', filterData.season.map(function(s) {
                    return { title: s.title, selected: s.number === currentSeason, season: s.number };
                }));

                filter.onSelect = function(type, a) {
                    if (a.season) {
                        currentSeason = a.season;
                        scroll.clear();
                        self.display();
                    }
                    Lampa.Select.close();
                };

                var current = filterData.season.find(function(s) { return s.number === currentSeason; });
                filter.chosen('filter', [current ? current.title : '']);
            }
        };

        this.showMessage = function(title, subtitle) {
            console.log('KinoPub: showMessage', title, subtitle);
            scroll.clear();
            var html = $('<div class="online-empty"></div>');
            html.append('<div class="online-empty__title">' + title + '</div>');
            html.append('<div class="online-empty__time">' + (subtitle || '') + '</div>');
            scroll.append(html);
            this.loading(false);
            Lampa.Controller.enable('content');
        };

        this.loading = function(status) {
            if (status) this.activity.loader(true);
            else {
                this.activity.loader(false);
                this.activity.toggle();
            }
        };

        this.create = function() { return this.render(); };

        this.start = function() {
            if (Lampa.Activity.active().activity !== this.activity) return;
            if (!initialized) {
                initialized = true;
                this.initialize();
            }

            Lampa.Background.immediately(Lampa.Utils.cardImgBackgroundBlur(object.movie));

            Lampa.Controller.add('content', {
                toggle: function() {
                    Lampa.Controller.collectionSet(scroll.render(), files.render());
                    Lampa.Controller.collectionFocus(last || false, scroll.render());
                },
                up: function() {
                    if (Navigator.canmove('up')) Navigator.move('up');
                    else Lampa.Controller.toggle('head');
                },
                down: function() { Navigator.move('down'); },
                right: function() {
                    if (Navigator.canmove('right')) Navigator.move('right');
                    else if (filterData.season.length > 1) filter.show('Сезон', 'filter');
                },
                left: function() {
                    if (Navigator.canmove('left')) Navigator.move('left');
                    else Lampa.Controller.toggle('menu');
                },
                back: this.back.bind(this)
            });

            Lampa.Controller.toggle('content');
        };

        this.render = function() { return files.render(); };
        this.back = function() { Lampa.Activity.backward(); };
        this.pause = function() {};
        this.stop = function() {};
        this.destroy = function() {
            network.clear();
            files.destroy();
            scroll.destroy();
        };
    }

    function addStyles() {
        var style = document.createElement('style');
        style.textContent = '.kinopub-item { padding: 1em; background: rgba(0,0,0,0.3); border-radius: 0.3em; margin-bottom: 0.5em; position: relative; }';
        style.textContent += ' .kinopub-item.focus::after { content: ""; position: absolute; top: -0.3em; left: -0.3em; right: -0.3em; bottom: -0.3em; border: 0.2em solid #fff; border-radius: 0.5em; }';
        style.textContent += ' .kinopub-item__title { font-size: 1.2em; }';
        style.textContent += ' .kinopub-item__info { opacity: 0.7; margin-top: 0.3em; }';
        style.textContent += ' .kinopub-item__quality { background: rgba(255,255,255,0.2); padding: 0.1em 0.4em; border-radius: 0.2em; }';
        document.head.appendChild(style);
    }

    function startPlugin() {
        if (window.kinopub_plugin) return;
        window.kinopub_plugin = true;

        console.log('KinoPub: Starting plugin v' + CONFIG.version);

        addStyles();

        Lampa.Component.add('kinopub', KinoPubComponent);

        Lampa.Manifest.plugins = {
            type: 'video',
            version: CONFIG.version,
            name: CONFIG.name,
            description: 'KinoPub балансер',
            component: 'kinopub',
            onContextMenu: function() { return { name: 'KinoPub', description: '' }; },
            onContextLauch: function(object) {
                Lampa.Activity.push({
                    url: '',
                    title: 'KinoPub',
                    component: 'kinopub',
                    movie: object,
                    page: 1
                });
            }
        };

        Lampa.Listener.follow('full', function(e) {
            if (e.type === 'complite') {
                var render = e.object.activity.render();
                if (render.find('.kinopub-btn').length) return;

                var btn = $('<div class="full-start__button selector kinopub-btn" data-subtitle="KinoPub"></div>');
                btn.append('<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>');
                btn.append('<span>KinoPub</span>');

                btn.on('hover:enter', function() {
                    Lampa.Activity.push({
                        url: '',
                        title: 'KinoPub',
                        component: 'kinopub',
                        movie: e.data.movie,
                        page: 1
                    });
                });

                render.find('.view--torrent').after(btn);
            }
        });

        console.log('KinoPub Plugin v' + CONFIG.version + ' loaded');
    }

    if (window.appready) startPlugin();
    else Lampa.Listener.follow('app', function(e) {
        if (e.type === 'ready') startPlugin();
    });

})();
