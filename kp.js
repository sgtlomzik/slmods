/**
 * KinoPub Balancer for Lampa
 * Версия: 2.0.0
 */

(function() {
    'use strict';

    // ========================================================================
    // КОНФИГУРАЦИЯ
    // ========================================================================
    
    var CONFIG = {
        name: 'KinoPub',
        version: '2.0.0',
        apiBase: 'https://api.service-kp.com/v1',
        token: '1ksgubh1qkewyq3u4z65bpnwn9eshhn2',
        protocol: 'http'
    };

    // ========================================================================
    // API
    // ========================================================================
    
    function apiRequest(path, params) {
        return new Promise(function(resolve, reject) {
            var url = CONFIG.apiBase + path;

            if (params) {
                var query = Object.keys(params).map(function(key) {
                    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
                }).join('&');
                url += '?' + query;
            }

            var network = new Lampa.Reguest();

            network.native(url, function(response) {
                if (typeof response === 'string') {
                    try { response = JSON.parse(response); } catch(e) {}
                }
                resolve(response);
            }, function(err) {
                reject(err);
            }, false, {
                headers: { 'Authorization': 'Bearer ' + CONFIG.token },
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

    // ========================================================================
    // ПАРСИНГ ВИДЕО
    // ========================================================================
    
    function extractVideoUrl(files) {
        if (!files || !files.length) return null;

        var allQualities = {};
        var protocols = ['hls4', 'hls', 'http'];

        var sorted = files.slice().sort(function(a, b) {
            return (b.quality_id || 0) - (a.quality_id || 0);
        });

        var bestUrl = null;
        var bestQuality = null;

        for (var i = 0; i < sorted.length; i++) {
            var file = sorted[i];
            if (!file.url) continue;

            for (var p = 0; p < protocols.length; p++) {
                var protocol = protocols[p];
                if (file.url[protocol]) {
                    if (!allQualities[file.quality]) {
                        allQualities[file.quality] = file.url[protocol];
                    }
                    if (!bestUrl) {
                        bestUrl = file.url[protocol];
                        bestQuality = file.quality;
                    }
                }
            }
        }

        if (!bestUrl) return null;

        return {
            url: bestUrl,
            quality: bestQuality,
            qualities: allQualities
        };
    }

    function buildFileList(item) {
        var files = [];

        // Фильмы
        if (item.videos && item.videos.length) {
            item.videos.forEach(function(video) {
                var extracted = extractVideoUrl(video.files);
                if (!extracted) return;

                files.push({
                    title: video.title || item.title,
                    quality: extracted.quality,
                    url: extracted.url,
                    qualitys: extracted.qualities,
                    subtitles: (video.subtitles || []).map(function(s) {
                        return { label: s.lang, url: s.url };
                    }),
                    voice: item.voice || '',
                    year: item.year,
                    duration: item.duration ? formatDuration(item.duration.total) : '',
                    poster: item.posters ? item.posters.medium : ''
                });
            });
        }

        // Сериалы
        if (item.seasons && item.seasons.length) {
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
                        voice: item.voice || '',
                        duration: episode.duration ? formatDuration(episode.duration) : '',
                        poster: episode.thumbnail || (item.posters ? item.posters.medium : '')
                    });
                });
            });
        }

        return files;
    }

    function formatDuration(seconds) {
        if (!seconds) return '';
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        if (h > 0) {
            return h + ':' + (m < 10 ? '0' : '') + m;
        }
        return m + ' мин';
    }

    // ========================================================================
    // КОМПОНЕНТ
    // ========================================================================
    
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
        var kinopubItem = null;

        files.appendFiles(scroll.render());
        files.appendHead(filter.render());

        // ====================================================================
        // ИНИЦИАЛИЗАЦИЯ
        // ====================================================================
        
        this.initialize = function() {
            var self = this;
            this.loading(true);

            var movie = object.movie;
            var query = movie.title || movie.name || movie.original_title || movie.original_name;

            searchContent(query).then(function(response) {
                if (response && response.items && response.items.length) {
                    var items = response.items;
                    var found = self.findBestMatch(items, movie);

                    if (found) {
                        // Точное совпадение — сразу загружаем и воспроизводим
                        self.loadAndPlay(found.id);
                    } else if (items.length === 1) {
                        // Один результат — сразу воспроизводим
                        self.loadAndPlay(items[0].id);
                    } else {
                        // Несколько результатов — показываем выбор
                        self.showSearchResults(items);
                    }
                } else {
                    self.showMessage('Ничего не найдено', 'Поиск: ' + query);
                }
            }).catch(function(err) {
                self.showMessage('Ошибка поиска', err.message || '');
            });
        };

        // ====================================================================
        // ПОИСК И ЗАГРУЗКА
        // ====================================================================
        
        this.findBestMatch = function(items, movie) {
            var year = parseInt((movie.release_date || movie.first_air_date || '0').substring(0, 4));
            var title = (movie.title || movie.name || '').toLowerCase().trim();
            var originalTitle = (movie.original_title || movie.original_name || '').toLowerCase().trim();

            return items.find(function(item) {
                var itemTitle = (item.title || '').toLowerCase();
                // Убираем часть после " / " для сравнения
                var itemTitleClean = itemTitle.split(' / ')[0].trim();
                var itemYear = item.year;

                var yearMatch = !year || !itemYear || Math.abs(year - itemYear) <= 1;
                var titleMatch = itemTitleClean === title || 
                                 itemTitle === title ||
                                 itemTitle.indexOf(originalTitle) !== -1 ||
                                 itemTitleClean === originalTitle;

                return yearMatch && titleMatch;
            });
        };

        this.loadAndPlay = function(id) {
            var self = this;

            getItem(id).then(function(response) {
                if (response && response.item) {
                    kinopubItem = response.item;
                    videoFiles = buildFileList(response.item);

                    if (videoFiles.length === 1 && !response.item.seasons) {
                        // Один файл (фильм) — сразу воспроизводим
                        self.play(videoFiles[0], videoFiles);
                    } else if (videoFiles.length > 0) {
                        // Несколько файлов (сериал или несколько версий) — показываем список
                        self.buildFilters();
                        self.display();
                    } else {
                        self.showMessage('Видео не найдено', '');
                    }
                } else {
                    self.showMessage('Контент не найден', '');
                }
            }).catch(function(err) {
                self.showMessage('Ошибка загрузки', err.message || '');
            });
        };

        this.loadItem = function(id) {
            var self = this;
            scroll.clear();
            this.loading(true);

            getItem(id).then(function(response) {
                if (response && response.item) {
                    kinopubItem = response.item;
                    videoFiles = buildFileList(response.item);

                    if (videoFiles.length > 0) {
                        self.buildFilters();
                        self.display();
                    } else {
                        self.showMessage('Видео не найдено', '');
                    }
                } else {
                    self.showMessage('Контент не найден', '');
                }
            }).catch(function(err) {
                self.showMessage('Ошибка загрузки', err.message || '');
            });
        };

        // ====================================================================
        // ОТОБРАЖЕНИЕ
        // ====================================================================
        
        this.showSearchResults = function(items) {
            var self = this;
            scroll.clear();

            items.forEach(function(item) {
                var html = self.createSearchCard(item);

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

        this.createSearchCard = function(item) {
            var poster = item.posters ? item.posters.small : '';
            var year = item.year || '';
            var type = item.type === 'serial' ? 'Сериал' : 'Фильм';

            var html = $('<div class="kinopub-card selector"></div>');
            
            // Постер
            var imgBox = $('<div class="kinopub-card__img"></div>');
            if (poster) {
                var img = $('<img />');
                img.on('error', function() {
                    imgBox.addClass('kinopub-card__img--empty');
                });
                img.attr('src', poster);
                imgBox.append(img);
            } else {
                imgBox.addClass('kinopub-card__img--empty');
            }
            html.append(imgBox);

            // Контент
            var body = $('<div class="kinopub-card__body"></div>');
            body.append('<div class="kinopub-card__title">' + item.title + '</div>');
            body.append('<div class="kinopub-card__info">' + year + ' • ' + type + '</div>');
            html.append(body);

            return html;
        };

        this.display = function() {
            var self = this;
            scroll.clear();

            var filtered = videoFiles;
            if (currentSeason && filterData.season.length) {
                filtered = videoFiles.filter(function(f) {
                    return f.season === currentSeason;
                });
            }

            filtered.forEach(function(file) {
                var html = self.createVideoCard(file);

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

        this.createVideoCard = function(file) {
            var title = file.title;
            if (file.season && file.episode) {
                title = file.episode + '. ' + file.title;
            }

            var html = $('<div class="kinopub-card selector"></div>');
            
            // Постер / Превью
            var imgBox = $('<div class="kinopub-card__img"></div>');
            if (file.poster) {
                var img = $('<img />');
                img.on('error', function() {
                    imgBox.addClass('kinopub-card__img--empty');
                });
                img.attr('src', file.poster);
                imgBox.append(img);
            } else {
                imgBox.addClass('kinopub-card__img--empty');
            }
            
            // Номер эпизода поверх картинки
            if (file.episode) {
                imgBox.append('<div class="kinopub-card__episode">' + file.episode + '</div>');
            }
            
            html.append(imgBox);

            // Контент
            var body = $('<div class="kinopub-card__body"></div>');
            
            // Заголовок
            body.append('<div class="kinopub-card__title">' + title + '</div>');
            
            // Информация
            var infoItems = [];
            if (file.voice) infoItems.push(file.voice);
            if (file.year && !file.season) infoItems.push(file.year);
            
            if (infoItems.length) {
                body.append('<div class="kinopub-card__info">' + infoItems.join(' • ') + '</div>');
            }
            
            html.append(body);

            // Правая часть (время и качество)
            var meta = $('<div class="kinopub-card__meta"></div>');
            if (file.duration) {
                meta.append('<div class="kinopub-card__time">' + file.duration + '</div>');
            }
            if (file.quality) {
                meta.append('<div class="kinopub-card__quality">' + file.quality + '</div>');
            }
            html.append(meta);

            return html;
        };

        this.buildFilters = function() {
            filterData.season = [];
            var seasons = {};

            videoFiles.forEach(function(f) {
                if (f.season) seasons[f.season] = true;
            });

            var seasonNumbers = Object.keys(seasons).map(Number).sort(function(a, b) { return a - b; });

            if (seasonNumbers.length >= 1) {
                filterData.season = seasonNumbers.map(function(n) {
                    return { title: 'Сезон ' + n, number: n };
                });
                currentSeason = seasonNumbers[0];
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

        // ====================================================================
        // ВОСПРОИЗВЕДЕНИЕ
        // ====================================================================
        
        this.play = function(file, playlist) {
            var lampaPlaylist = playlist.map(function(f) {
                var title = f.title;
                if (f.season && f.episode) {
                    title = '[S' + f.season + '/E' + f.episode + '] ' + f.title;
                }
                return {
                    title: title,
                    url: f.url,
                    quality: f.qualitys,
                    subtitles: f.subtitles,
                    season: f.season,
                    episode: f.episode
                };
            });

            var currentIndex = playlist.indexOf(file);
            var current = lampaPlaylist[currentIndex];

            if (current.url) {
                if (object.movie.id) {
                    Lampa.Favorite.add('history', object.movie, 100);
                }
                current.playlist = lampaPlaylist;
                Lampa.Player.play(current);
                Lampa.Player.playlist(lampaPlaylist);
            } else {
                Lampa.Noty.show('Ссылка не найдена');
            }
        };

        // ====================================================================
        // СООБЩЕНИЯ
        // ====================================================================
        
        this.showMessage = function(title, subtitle) {
            scroll.clear();
            var html = $('<div class="kinopub-empty"></div>');
            html.append('<div class="kinopub-empty__title">' + title + '</div>');
            if (subtitle) {
                html.append('<div class="kinopub-empty__subtitle">' + subtitle + '</div>');
            }
            scroll.append(html);
            this.loading(false);
            Lampa.Controller.enable('content');
        };

        this.loading = function(status) {
            if (status) {
                this.activity.loader(true);
            } else {
                this.activity.loader(false);
                this.activity.toggle();
            }
        };

        // ====================================================================
        // СТАНДАРТНЫЕ МЕТОДЫ LAMPA
        // ====================================================================
        
        this.create = function() {
            return this.render();
        };

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
                down: function() {
                    Navigator.move('down');
                },
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

        this.render = function() {
            return files.render();
        };

        this.back = function() {
            Lampa.Activity.backward();
        };

        this.pause = function() {};
        this.stop = function() {};

        this.destroy = function() {
            network.clear();
            files.destroy();
            scroll.destroy();
        };
    }

    // ========================================================================
    // СТИЛИ
    // ========================================================================
    
    function addStyles() {
        var css = [
            // Карточка
            '.kinopub-card {',
            '    display: flex;',
            '    align-items: center;',
            '    padding: 1em;',
            '    margin-bottom: 0.5em;',
            '    background: rgba(0,0,0,0.3);',
            '    border-radius: 0.5em;',
            '    position: relative;',
            '    transition: background 0.2s;',
            '}',
            '.kinopub-card.focus {',
            '    background: rgba(255,255,255,0.1);',
            '}',
            '.kinopub-card.focus::before {',
            '    content: "";',
            '    position: absolute;',
            '    top: -0.3em;',
            '    left: -0.3em;',
            '    right: -0.3em;',
            '    bottom: -0.3em;',
            '    border: 0.2em solid #fff;',
            '    border-radius: 0.7em;',
            '    pointer-events: none;',
            '}',

            // Изображение
            '.kinopub-card__img {',
            '    width: 8em;',
            '    height: 5em;',
            '    flex-shrink: 0;',
            '    margin-right: 1.2em;',
            '    border-radius: 0.4em;',
            '    overflow: hidden;',
            '    background: rgba(255,255,255,0.1);',
            '    position: relative;',
            '}',
            '.kinopub-card__img img {',
            '    width: 100%;',
            '    height: 100%;',
            '    object-fit: cover;',
            '}',
            '.kinopub-card__img--empty {',
            '    display: flex;',
            '    align-items: center;',
            '    justify-content: center;',
            '}',
            '.kinopub-card__img--empty::after {',
            '    content: "🎬";',
            '    font-size: 2em;',
            '    opacity: 0.5;',
            '}',

            // Номер эпизода
            '.kinopub-card__episode {',
            '    position: absolute;',
            '    top: 50%;',
            '    left: 50%;',
            '    transform: translate(-50%, -50%);',
            '    font-size: 1.5em;',
            '    font-weight: bold;',
            '    text-shadow: 0 0 0.5em rgba(0,0,0,0.8);',
            '}',

            // Тело карточки
            '.kinopub-card__body {',
            '    flex-grow: 1;',
            '    min-width: 0;',
            '}',
            '.kinopub-card__title {',
            '    font-size: 1.2em;',
            '    font-weight: 500;',
            '    margin-bottom: 0.3em;',
            '    white-space: nowrap;',
            '    overflow: hidden;',
            '    text-overflow: ellipsis;',
            '}',
            '.kinopub-card__info {',
            '    font-size: 0.9em;',
            '    color: rgba(255,255,255,0.6);',
            '    white-space: nowrap;',
            '    overflow: hidden;',
            '    text-overflow: ellipsis;',
            '}',

            // Мета (справа)
            '.kinopub-card__meta {',
            '    flex-shrink: 0;',
            '    text-align: right;',
            '    margin-left: 1em;',
            '}',
            '.kinopub-card__time {',
            '    font-size: 1em;',
            '    margin-bottom: 0.3em;',
            '}',
            '.kinopub-card__quality {',
            '    display: inline-block;',
            '    padding: 0.2em 0.5em;',
            '    background: rgba(255,255,255,0.15);',
            '    border-radius: 0.3em;',
            '    font-size: 0.85em;',
            '}',

            // Пустое сообщение
            '.kinopub-empty {',
            '    padding: 3em;',
            '    text-align: center;',
            '}',
            '.kinopub-empty__title {',
            '    font-size: 1.5em;',
            '    margin-bottom: 0.5em;',
            '}',
            '.kinopub-empty__subtitle {',
            '    font-size: 1em;',
            '    color: rgba(255,255,255,0.6);',
            '}'
        ].join('\n');

        var style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ========================================================================
    // ЗАПУСК
    // ========================================================================
    
    function startPlugin() {
        if (window.kinopub_plugin) return;
        window.kinopub_plugin = true;

        addStyles();

        Lampa.Component.add('kinopub', KinoPubComponent);

        Lampa.Manifest.plugins = {
            type: 'video',
            version: CONFIG.version,
            name: CONFIG.name,
            description: 'KinoPub'
        };

        // Кнопка на карточке фильма
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
    }

    // Ждём готовности Lampa
    if (window.appready) {
        startPlugin();
    } else {
        Lampa.Listener.follow('app', function(e) {
            if (e.type === 'ready') startPlugin();
        });
    }

})();
