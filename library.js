window.KOKKY = {
  source: {
    name: "неизвестно",
    url: "https://soundcloud.com",
    about: "полные треки · без аккаунта",
  },
  // Каталог не отдаёт CORS для поиска, поэтому запросы идут через
  // маленький прокси. Приложение перебирает список по порядку и запоминает
  // рабочий: r.jina.ai хорош снаружи, но из России отвечает 451, поэтому
  // вторым идёт corsfix, доступный из РФ.
  // Если развернёте свой воркер (см. worker/README.md) — укажите его первым:
  // proxy: "https://kokky-sc.example.workers.dev/?url="
  soundcloud: {
    clientId: "qLcgHhXgeEFFaSolTB9I71LBsqncsD93",
    proxy: "",
    proxies: [
      "https://r.jina.ai/",
      "https://proxy.corsfix.com/?url=",
    ],
    // Прокси для самого аудио. Нужен, только если медиа-CDN закрыт у провайдера:
    // включается автоматически после двух сбоев прямого потока.
    mediaProxy: "https://proxy.corsfix.com/?url=",
  },
  // Запросы, из которых собирается «Мой поток».
  feedQueries: [
    "pop hits",
    "hip hop",
    "r&b",
    "electronic",
    "indie",
    "chill",
  ],
  // «Исполнители»: популярные артисты СНГ. query — что искать в каталоге,
  // aliases — другие написания имени (латиница, «ё», дефисы). Треки
  // подтягиваются по названию и аккаунту, так что в список попадает всё,
  // что реально есть в каталоге.
  artists: [
    { name: "Скриптонит", tag: "рэп" },
    { name: "Баста", tag: "рэп", aliases: ["Basta"] },
    { name: "Макс Корж", tag: "рэп" },
    { name: "Океан Ельзи", tag: "рок" },
    { name: "ЛСП", tag: "рэп" },
    { name: "Хаски", tag: "рэп" },
    { name: "Моргенштерн", tag: "рэп", aliases: ["Morgenshtern"] },
    { name: "Оксимирон", tag: "рэп", query: "Oxxxymiron", aliases: ["Oxxxymiron"] },
    { name: "Big Baby Tape", tag: "рэп" },
    { name: "Элджей", tag: "рэп" },
    { name: "FACE", tag: "рэп" },
    { name: "PHARAOH", tag: "рэп" },
    { name: "Каспийский Груз", tag: "рэп" },
    { name: "Noize MC", tag: "рэп" },
    { name: "Anacondaz", tag: "рэп" },
    { name: "GONE.Fludd", tag: "рэп" },
    { name: "Смоки Мо", tag: "рэп" },
    { name: "Тимати", tag: "рэп" },
    { name: "Мот", tag: "поп" },
    { name: "Нюша", tag: "поп", aliases: ["Nyusha"] },
    { name: "LOBODA", tag: "поп", aliases: ["Лобода"] },
    { name: "MONATIK", tag: "поп", aliases: ["Монатик"] },
    { name: "Zivert", tag: "поп", aliases: ["Зиверт"] },
    { name: "Три дня дождя", tag: "поп" },
    { name: "Жанулька", tag: "поп", query: "zhanulka", aliases: ["zhanulka"] },
    { name: "alyona alyona", tag: "хип-хоп", aliases: ["алена алена"] },
    { name: "KALUSH", tag: "хип-хоп", aliases: ["Калуш"] },
    { name: "ДДТ", tag: "рок" },
    { name: "Кино", tag: "рок", aliases: ["Виктор Цой"] },
    { name: "Земфира", tag: "рок" },
    { name: "Сплин", tag: "рок" },
    { name: "Би-2", tag: "рок", aliases: ["Би 2", "Би2"] },
    { name: "Валентин Стрыкало", tag: "рок" },
  ],
};
