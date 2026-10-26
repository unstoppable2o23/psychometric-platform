-- 0005_commerce.sql
-- Products, orders, payments, invoices, and the assessment credit ledger.

-- All money is stored in the minor unit (paise) as bigint. No floats.

create table products (
  id                uuid primary key default gen_random_uuid(),
  assessment_id     uuid        not null references assessments (id) on delete cascade,
  name              text        not null,
  description       text        not null default '',
  price_in_paise    bigint      not null check (price_in_paise >= 0),
  currency          text        not null default 'INR' check (currency = 'INR'),
  tax_rate_bp       int         not null default 0 check (tax_rate_bp between 0 and 10000),
  is_active         boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (assessment_id)
);

comment on column products.tax_rate_bp is 'Tax in basis points, e.g. 1800 = 18%. Admin-configurable.';

create table discount_codes (
  id           uuid primary key default gen_random_uuid(),
  code         text           not null unique,
  kind         app.discount_kind not null,
  value        numeric(9,2)   not null check (value > 0),
  max_uses     int,
  used_count   int            not null default 0,
  min_subtotal_in_paise bigint not null default 0,
  organization_id uuid        references organizations (id) on delete cascade,
  expires_at   timestamptz,
  is_active    boolean        not null default true,
  created_at   timestamptz    not null default now(),
  check (kind <> 'percent' or value <= 100)
);

create table orders (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid        not null references organizations (id) on delete restrict,
  reference         text        not null unique,
  status            app.order_status not null default 'created',
  currency          text        not null default 'INR',
  subtotal_in_paise bigint      not null check (subtotal_in_paise >= 0),
  discount_in_paise bigint      not null default 0 check (discount_in_paise >= 0),
  tax_in_paise      bigint      not null default 0 check (tax_in_paise >= 0),
  total_in_paise    bigint      not null check (total_in_paise >= 0),
  discount_code_id  uuid        references discount_codes (id) on delete set null,
  -- Repeated webhook deliveries for the same checkout collapse onto one row.
  idempotency_key   text        not null unique,
  provider          text        not null default 'fake',
  provider_order_id text,
  contact_email     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (total_in_paise = subtotal_in_paise - discount_in_paise + tax_in_paise)
);

create index orders_org_idx on orders (organization_id, created_at desc);
create index orders_status_idx on orders (status) where status = 'created';

create table order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid        not null references orders (id) on delete cascade,
  product_id       uuid        not null references products (id) on delete restrict,
  quantity         int         not null check (quantity > 0),
  unit_price_in_paise bigint   not null check (unit_price_in_paise >= 0),
  -- Price captured at purchase time; a later price edit must not rewrite history.
  product_name     text        not null
);

create index order_items_order_idx on order_items (order_id);

create table payments (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid        not null references orders (id) on delete cascade,
  provider          text        not null default 'fake',
  -- Natural key from the provider. The unique index is what makes webhook
  -- processing idempotent: a redelivered event conflicts instead of double-crediting.
  provider_payment_id text      not null,
  status            app.payment_status not null default 'created',
  amount_in_paise   bigint      not null check (amount_in_paise >= 0),
  currency          text        not null default 'INR',
  signature          text,
  signature_valid   boolean,
  event_type        text,
  raw_payload       jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (provider, provider_payment_id)
);

create index payments_order_idx on payments (order_id, created_at desc);

create table invoices (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid        not null unique references orders (id) on delete cascade,
  number       text        not null unique,
  currency     text        not null default 'INR',
  total_in_paise bigint    not null check (total_in_paise >= 0),
  tax_in_paise bigint      not null default 0,
  issued_at    timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Credit ledger
--
-- Balance is a running total, not a stored mutable counter. Two concurrent
-- assignment attempts both read the same balance and both try to decrement it;
-- only an append + recompute is safe without external locking.
-- ---------------------------------------------------------------------------
create table credit_transactions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid        not null references organizations (id) on delete cascade,
  product_id       uuid        not null references products (id) on delete restrict,
  -- Positive credits the balance, negative consumes it.
  delta            int         not null check (delta <> 0),
  reason           text        not null,
  order_id         uuid        references orders (id) on delete set null,
  order_item_id    uuid        references order_items (id) on delete set null,
  assignment_id    uuid        references assessment_assignments (id) on delete set null,
  created_at       timestamptz not null default now(),
  -- A given order item can only ever mint credits once.
  unique (order_item_id)
);

create index credit_tx_org_idx on credit_transactions (organization_id, created_at desc);

create or replace view app.credit_balances as
select organization_id,
       product_id,
       sum(delta)::bigint as balance
  from credit_transactions
 group by organization_id, product_id;

comment on view app.credit_balances is
  'Authoritative credit balance per organization and product. Read this inside a transaction before assigning.';

create or replace function app.spend_credit(
  p_org_id     uuid,
  p_product_id uuid,
  p_amount     int,
  p_reason     text,
  p_assignment uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_balance bigint;
  v_tx_id    uuid;
begin
  -- Serialise competing spends on the same account without a deadlock-prone
  -- table lock: the organisation row is the natural mutex.
  perform 1 from organizations where id = p_org_id for update;

  select coalesce(sum(delta), 0) into v_balance
    from credit_transactions
   where organization_id = p_org_id and product_id = p_product_id;

  if v_balance < p_amount then
    raise exception 'insufficient credits: % available, % requested', v_balance, p_amount
      using errcode = 'check_violation';
  end if;

  insert into credit_transactions (organization_id, product_id, delta, reason, assignment_id)
  values (p_org_id, p_product_id, -p_amount, p_reason, p_assignment)
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

create trigger products_touch before update on products for each row execute function app.touch_updated_at();
create trigger orders_touch   before update on orders   for each row execute function app.touch_updated_at();
create trigger payments_touch before update on payments for each row execute function app.touch_updated_at();
