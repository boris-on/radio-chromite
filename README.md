# RADIO CHROMITE

Веб-интерфейс на Next.js и отдельный аудиобэкенд на Nim. Бэкенд сканирует MP3-библиотеку, выбирает треки по ротации `исполнитель → альбом → трек`, извлекает обложки через FFmpeg и отдаёт аудио с поддержкой HTTP Range.

## Требования

- Node.js 20+ и npm;
- Nim 2.0+ (в Docker используется Nim 2.2.10);
- C-компилятор, совместимый с Nim: GCC/MinGW-w64 или Clang;
- FFmpeg и FFprobe;
- Docker с Compose — только для контейнерного запуска.

Проверьте локальные инструменты:

```powershell
node --version
npm --version
nim --version
gcc --version
ffmpeg -version
ffprobe -version
```

## Настройка

Скопируйте `.env.example` в `.env`:

```powershell
Copy-Item .env.example .env
```

```bash
cp .env.example .env
```

Корневой `.env` хранит машинно-зависимые пути. Пример для Windows:

```dotenv
MUSIC_LIBRARY_PATH=C:\Music\Radio
# NORMALIZED_LIBRARY_PATH=C:\Music\Radio-normalized
# NIM_BIN_DIR=C:\nim\nim-2.2.10\bin
# C_COMPILER_BIN_DIR=C:\msys64\mingw64\bin
# FFMPEG_BIN_DIR=C:\ffmpeg\bin
RADIO_DOMAIN=radio.example.com
```

Пример для Linux:

```dotenv
MUSIC_LIBRARY_PATH=/srv/radio-chromite/music
# NORMALIZED_LIBRARY_PATH=/srv/radio-chromite/music-normalized
# NIM_BIN_DIR=/opt/nim/bin
# C_COMPILER_BIN_DIR=/opt/gcc/bin
# FFMPEG_BIN_DIR=/opt/ffmpeg/bin
RADIO_DOMAIN=radio.example.com
```

Относительные пути вычисляются от корня проекта. Если `MUSIC_LIBRARY_PATH` не задан, используется каталог `music` в проекте. `AUDIO_SERVER_PORT` по умолчанию равен `8789`.

## Формат музыкальной библиотеки

Название папки альбома должно иметь вид `ИСПОЛНИТЕЛЬ - АЛЬБОМ`. Название трека берётся из имени MP3-файла; префикс `ИСПОЛНИТЕЛЬ - ` можно не указывать:

```text
music/
├── priorities.txt
├── Orgy - Candyass/
│   ├── Blue Monday.mp3
│   └── Orgy - Stitches.mp3
└── Zeromancer - Eurotrash/
    └── Doctor Online.mp3
```

Необязательный `priorities.txt` задаёт вес трека внутри выбранного альбома:

```text
# относительный путь | вес
Orgy - Candyass/Blue Monday.mp3 | 2
Orgy - Candyass/Orgy - Stitches.mp3 | 1.5
Zeromancer - Eurotrash/Doctor Online.mp3 | 3
```

Вес по умолчанию — `1`. Вес `0` полностью исключает трек из ротации. Бэкенд перечитывает библиотеку и приоритеты каждые 30 секунд.

## Локальный запуск бэкенда

Из корня проекта выполните:

```powershell
npm install
npm run backend
```

`npm run backend` переходит в `backend-nim`, компилирует release-версию через Nimble и сразу запускает её. Переменные `NIM_BIN_DIR`, `C_COMPILER_BIN_DIR` и `FFMPEG_BIN_DIR` из корневого `.env` автоматически добавляются в `PATH` дочернего процесса.

После запуска доступны:

```text
http://localhost:8789/api/health
http://localhost:8789/api/tracks
http://localhost:8789/api/random-track
```

Проверка из PowerShell:

```powershell
Invoke-RestMethod http://localhost:8789/api/health
Invoke-RestMethod http://localhost:8789/api/random-track
```

Альтернативные обёртки запуска:

```powershell
.\backend-nim\run.ps1
```

```bash
sh backend-nim/run.sh
```

## Отдельная сборка бэкенда

Чтобы собрать бинарник без запуска:

```powershell
Set-Location backend-nim
nimble build -d:release
```

```bash
cd backend-nim
nimble build -d:release
```

Результат:

- Windows: `backend-nim/radio_chromite_backend.exe`;
- Linux: `backend-nim/radio_chromite_backend`.

Запускайте готовый бинарник из корня проекта, чтобы относительные пути и `.cover-cache` оставались предсказуемыми:

```powershell
.\backend-nim\radio_chromite_backend.exe
```

```bash
./backend-nim/radio_chromite_backend
```

Важно: готовый бинарник сам не загружает корневой `.env`. Перед прямым запуском задайте переменные окружения в терминале либо используйте `npm run backend`, который загружает `.env` автоматически.

## Тесты планировщика

```powershell
nim c -r -d:schedulerTests backend-nim/tests/test_scheduler.nim
```

Тесты проверяют равномерность выбора исполнителей и альбомов, веса треков, нулевой вес, repeat windows, fallback и разбор `priorities.txt`.

Быстрая проверка Nim-кода без вызова C-компилятора:

```powershell
nim check backend-nim/src/radio_chromite_backend.nim
nim check -d:schedulerTests backend-nim/tests/test_scheduler.nim
```

## Нормализация громкости

```powershell
npm run normalize
```

По умолчанию результат записывается в `<MUSIC_LIBRARY_PATH>-normalized`. Бэкенд всегда читает MP3 только из `NORMALIZED_LIBRARY_PATH` (или из `<MUSIC_LIBRARY_PATH>-normalized`, если переменная не задана) и не откатывается к оригинальной библиотеке. Поэтому перед первым запуском backend необходимо выполнить нормализацию. Повторный запуск пропускает готовые файлы и удаляет из нормализованной библиотеки MP3, которых больше нет в оригинале.

## Локальный запуск всего приложения

Первый терминал:

```powershell
npm install
npm run dev:frontend
```

Второй терминал:

```powershell
npm run backend
```

Интерфейс доступен по адресу `http://localhost:3000`, бэкенд — `http://localhost:8789`.

## Docker Compose

На Linux-сервере настройте `.env` как минимум так:

```dotenv
MUSIC_LIBRARY_PATH=/srv/radio-chromite/music
RADIO_DOMAIN=radio.example.com
```

Затем разрешите Docker читать библиотеку и запустите сервисы:

```bash
chmod -R a+rX /srv/radio-chromite/music
docker compose up -d --build
```

Compose запускает `caddy` (HTTPS reverse proxy), `frontend` (Next.js) и `backend` (Nim + FFmpeg). Состояние и логи:

```bash
docker compose ps
docker compose logs -f caddy backend frontend
curl https://radio.example.com/api/health
```

Обновление и остановка:

```bash
git pull
docker compose up -d --build
docker compose down
```

Обычный `docker compose down` сохраняет кэш обложек и сертификаты Caddy. `docker compose down -v` удаляет именованные тома вместе с данными.

## Проблемы со сборкой на Windows

Если `nim check` проходит, но `nimble build` завершается на `gcc.exe`, проверьте архитектуру инструментов и порядок каталогов в `PATH`:

```powershell
where.exe nim
where.exe gcc
$env:PATH = "C:\msys64\mingw64\bin;C:\nim\nim-2.2.10\bin;$env:PATH"
Set-Location backend-nim
nimble build -d:release
```

После обновления Nim или GCC удалите только кэш сборки и повторите команду:

```powershell
Remove-Item -Recurse -Force .\nimcache -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .\.nimcache -ErrorAction SilentlyContinue
nimble build -d:release
```

Если ошибка остаётся внутри сгенерированных файлов стандартной библиотеки Nim, переустановите согласованную пару Nim/MinGW-w64 либо соберите контейнер:

```powershell
docker compose build backend
docker compose up -d backend
```
