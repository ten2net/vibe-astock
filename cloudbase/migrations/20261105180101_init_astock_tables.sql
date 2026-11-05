create table if not exists stocks (
  code varchar(12) primary key,
  name varchar(32) not null,
  price numeric(10,2) not null,
  change_pct numeric(6,2) not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists watchlist (
  openid varchar(64) not null,
  code varchar(12) not null references stocks(code),
  created_at timestamptz not null default now(),
  primary key (openid, code)
);
create table if not exists review_summaries (
  trade_date date primary key,
  limit_up int not null default 0,
  limit_down int not null default 0,
  promotion_rate numeric(5,2),
  emotion_level varchar(16) not null,
  summary text not null,
  created_at timestamptz not null default now()
);
create table if not exists trades (
  id bigint generated always as identity primary key,
  openid varchar(64) not null,
  code varchar(12) not null,
  name varchar(32) not null,
  side varchar(4) not null check (side in ('BUY','SELL')),
  price numeric(10,2) not null check (price > 0),
  volume int not null check (volume > 0 and volume % 100 = 0),
  fee numeric(10,2) not null default 0,
  trade_time timestamptz not null,
  note varchar(200),
  created_at timestamptz not null default now()
);
create index if not exists idx_trades_openid_time on trades(openid, trade_time desc);
