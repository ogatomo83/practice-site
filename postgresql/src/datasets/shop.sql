-- 文具店「つばめ文具」のサンプルデータベース
-- 各章の「実行」ボタンを初めて押したとき、ブラウザの中の PostgreSQL にこれが流し込まれる。

create table categories (
  id        int primary key,
  name      text not null,
  parent_id int references categories(id)
);

insert into categories values
  (1, '筆記具', null),
  (2, '万年筆', 1),
  (3, 'ボールペン', 1),
  (4, '鉛筆', 1),
  (5, '紙製品', null),
  (6, 'ノート', 5),
  (7, '手帳', 5),
  (8, '雑貨', null),
  (9, 'インク', 1);

create table products (
  id          int primary key,
  name        text not null,
  category_id int not null references categories(id),
  price       int not null check (price >= 0),
  stock       int not null default 0,
  released_on date,
  tags        text[] not null default '{}',
  attrs       jsonb not null default '{}'
);

insert into products values
  (1,  'つばめ万年筆 細字',        2, 12000, 8,   '2021-04-01', '{定番,ギフト}',      '{"nib": "F", "color": "黒"}'),
  (2,  'つばめ万年筆 中字',        2, 12000, 3,   '2021-04-01', '{定番,ギフト}',      '{"nib": "M", "color": "紺"}'),
  (3,  'さらさらボールペン 0.5',   3, 180,   120, '2019-09-10', '{定番}',             '{"size": 0.5, "color": "黒"}'),
  (4,  'さらさらボールペン 0.7',   3, 180,   95,  '2019-09-10', '{定番}',             '{"size": 0.7, "color": "青"}'),
  (5,  '製図用鉛筆 HB',            4, 150,   200, '2018-02-15', '{}',                 '{"hardness": "HB"}'),
  (6,  '方眼ノート A5',            6, 450,   60,  '2020-01-20', '{定番,方眼}',        '{"size": "A5", "pages": 80}'),
  (7,  '方眼ノート B5',            6, 520,   45,  '2020-01-20', '{方眼}',             '{"size": "B5", "pages": 80}'),
  (8,  '無地ノート A5',            6, 420,   0,   '2022-06-01', '{}',                 '{"size": "A5", "pages": 96}'),
  (9,  '2026年 手帳 マンスリー',   7, 1800,  30,  '2025-09-01', '{季節}',             '{"year": 2026, "type": "monthly"}'),
  (10, 'ガラスペン',               8, 3500,  5,   '2023-11-11', '{ギフト}',           '{"material": "glass"}'),
  (11, 'ボトルインク 夜空',        9, 2200,  14,  '2022-03-03', '{ギフト,限定}',      '{"ml": 50, "color": "青黒"}'),
  (12, '真鍮クリップ',             8, 600,   40,  '2024-05-05', '{}',                 '{"material": "brass"}'),
  (13, '水彩色鉛筆 24色',          4, 4800,  12,  '2026-03-01', '{新商品}',           '{"colors": 24}');

create table customers (
  id         int primary key,
  name       text not null,
  email      text not null unique,
  prefecture text not null,
  joined_on  date not null,
  birth_year int
);

insert into customers values
  (1,  '佐藤 葵',   'aoi@example.com',     '東京都', '2023-01-15', 1990),
  (2,  '鈴木 蓮',   'ren@example.com',     '大阪府', '2023-03-02', 1985),
  (3,  '高橋 陽菜', 'hina@example.com',    '東京都', '2023-06-21', null),
  (4,  '田中 湊',   'minato@example.com',  '福岡県', '2023-11-30', 2001),
  (5,  '伊藤 結衣', 'yui@example.com',     '北海道', '2024-02-14', 1978),
  (6,  '渡辺 大翔', 'hiroto@example.com',  '大阪府', '2024-04-01', 1995),
  (7,  '山本 芽依', 'mei@example.com',     '愛知県', '2024-08-08', null),
  (8,  '中村 悠真', 'yuma@example.com',    '東京都', '2025-01-10', 1988),
  (9,  '小林 さくら','sakura@example.com', '京都府', '2025-05-05', 2003),
  (10, '加藤 樹',   'itsuki@example.com',  '東京都', '2025-10-01', 1970);

create table orders (
  id          int primary key,
  customer_id int not null references customers(id),
  ordered_at  timestamptz not null,
  status      text not null check (status in ('pending', 'paid', 'shipped', 'cancelled'))
);

insert into orders values
  (1,  1, '2025-01-05 10:12+09', 'shipped'),
  (2,  2, '2025-01-18 21:40+09', 'shipped'),
  (3,  1, '2025-02-02 09:05+09', 'shipped'),
  (4,  3, '2025-02-14 13:30+09', 'shipped'),
  (5,  4, '2025-03-01 18:22+09', 'cancelled'),
  (6,  5, '2025-03-20 08:45+09', 'shipped'),
  (7,  2, '2025-04-11 12:00+09', 'shipped'),
  (8,  6, '2025-05-03 15:15+09', 'shipped'),
  (9,  1, '2025-05-28 20:20+09', 'shipped'),
  (10, 7, '2025-06-30 11:11+09', 'shipped'),
  (11, 3, '2025-07-07 07:07+09', 'shipped'),
  (12, 8, '2025-08-15 16:40+09', 'shipped'),
  (13, 2, '2025-09-09 19:30+09', 'shipped'),
  (14, 9, '2025-10-10 10:10+09', 'shipped'),
  (15, 4, '2025-11-03 14:00+09', 'shipped'),
  (16, 1, '2025-12-12 22:22+09', 'shipped'),
  (17, 6, '2026-01-04 09:30+09', 'paid'),
  (18, 8, '2026-01-20 13:45+09', 'paid'),
  (19, 5, '2026-02-01 10:00+09', 'pending'),
  (20, 9, '2026-02-03 17:50+09', 'pending');

create table order_items (
  order_id   int not null references orders(id),
  product_id int not null references products(id),
  quantity   int not null check (quantity > 0),
  unit_price int not null,
  primary key (order_id, product_id)
);

insert into order_items values
  (1, 1, 1, 12000), (1, 11, 1, 2200),
  (2, 3, 5, 180),   (2, 6, 2, 450),
  (3, 6, 3, 450),   (3, 5, 10, 150),
  (4, 9, 1, 1800),
  (5, 10, 1, 3500),
  (6, 2, 1, 12000), (6, 11, 2, 2200), (6, 12, 1, 600),
  (7, 4, 3, 180),   (7, 7, 2, 520),
  (8, 3, 10, 180),
  (9, 9, 1, 1800),  (9, 6, 1, 450),
  (10, 10, 1, 3500),(10, 11, 1, 2200),
  (11, 6, 2, 450),  (11, 3, 2, 180),
  (12, 1, 1, 12000),
  (13, 5, 12, 150), (13, 7, 1, 520),
  (14, 8, 3, 420),  (14, 3, 1, 180),
  (15, 9, 2, 1800),
  (16, 11, 1, 2200),(16, 12, 2, 600), (16, 10, 1, 3500),
  (17, 6, 4, 450),
  (18, 2, 1, 12000),(18, 4, 2, 180),
  (19, 9, 1, 1700),
  (20, 1, 1, 12000),(20, 6, 1, 450);

create table employees (
  id         int primary key,
  name       text not null,
  manager_id int references employees(id),
  dept       text not null,
  salary     int not null,
  hired_on   date not null
);

insert into employees values
  (1, '燕 店長',   null, '本部', 520000, '2015-04-01'),
  (2, '石田 健',   1,    '店舗', 380000, '2017-04-01'),
  (3, '森 千尋',   1,    '通販', 400000, '2018-10-01'),
  (4, '岡 拓海',   2,    '店舗', 280000, '2021-04-01'),
  (5, '原 美月',   2,    '店舗', 265000, '2023-04-01'),
  (6, '西 翔',     3,    '通販', 300000, '2020-07-01'),
  (7, '松井 葉月', 3,    '通販', 300000, '2022-01-11'),
  (8, '木村 涼',   6,    '通販', 240000, '2025-04-01');

analyze;
