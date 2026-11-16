# Прокси для поиска по каталогу

Каталог отдаёт поиск только без CORS, поэтому браузер не может обратиться к
`api-v2.soundcloud.com` напрямую. Приложение по умолчанию использует публичный
`r.jina.ai`, но у него есть лимиты. Свой воркер снимает эти лимиты и работает быстрее.

## Развернуть (бесплатно, ~2 минуты)

1. Установите Wrangler (нужен Node.js):

   ```powershell
   npm install -g wrangler
   ```

2. Войдите в Cloudflare (откроется браузер):

   ```powershell
   wrangler login
   ```

3. Из папки `kokky\worker` запустите:

   ```powershell
   cd C:\Users\Admin\kokky\worker
   wrangler deploy
   ```

4. Wrangler покажет адрес вида
   `https://kokky-sc.<ваш-поддомен>.workers.dev`.

5. Пропишите его в `library.js`:

   ```js
   soundcloud: {
     clientId: "…",
     proxy: "https://kokky-sc.<ваш-поддомен>.workers.dev/?url=",
   },
   ```

6. Перезагрузите страницу. Поиск пойдёт через ваш воркер, `r.jina.ai` больше не нужен.

## Проверка

Откройте в браузере:

```
https://kokky-sc.<ваш-поддомен>.workers.dev/?url=https%3A%2F%2Fapi-v2.soundcloud.com%2Fsearch%2Ftracks%3Fq%3Dweeknd%26client_id%3DВАШ_CLIENT_ID%26limit%3D3
```

Должен вернуться JSON с `collection`.

## Ограничения

- Воркер пропускает только `api-v2.soundcloud.com` — это не открытый прокси.
- Кэш ответов — 5 минут, чтобы не дёргать каталог на каждый символ.
- Звук идёт не через воркер: приложение проигрывает прямые ссылки на медиа,
  а они отдаются с отдельного CDN с CORS. Воркер нужен только для метаданных
  и ссылок на поток.
