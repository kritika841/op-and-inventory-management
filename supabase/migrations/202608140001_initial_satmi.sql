begin;

create table if not exists users (id text primary key, email text not null unique, name text not null, role text not null, password_hash text not null, password_salt text not null, must_change_password integer not null default 1, active integer not null default 1, failed_attempts integer not null default 0, locked_until text, created_at text not null);
create table if not exists sessions (token_hash text primary key, user_id text not null, expires_at text not null, created_at text not null);
create table if not exists products (id text primary key, shopify_variant_id text, sku text not null unique, name text not null, variant text not null, image_url text, active integer not null default 1);
create table if not exists orders (id text primary key, shopify_order_id text, shopify_customer_id text, order_number text not null, normalized_order_number text generated always as (upper(btrim(ltrim(order_number, '#')))) stored, customer_name text not null, customer_phone text, payment_method text not null, amount integer not null, status text not null, current_status text not null default 'INGESTED', rto_risk text not null default 'UNTAGGED', rto_score integer, assigned_agent_id text, stuck_reason text, stuck_since text, stuck_notes text, confirmation_selected integer not null default 0, confirmation_status text not null default 'not-required', assigned_user_id text, shiprocket_order_id text, shipment_id text, awb text, courier text, tracking_status text, cancellation_source text, cancellation_reason text, cancelled_by text, cancelled_at text, label_key text, warehouse_acknowledged integer not null default 0, rto_eta text, shipping_address text, shipping_city text, shipping_state text, shipping_pincode text, shipping_country text, created_at text not null, updated_at text not null, constraint orders_normalized_number_unique unique(normalized_order_number));
create table if not exists order_lines (id text primary key, order_id text not null, product_id text, sku text not null, name text not null, quantity integer not null, allocated_quantity integer not null default 0);
create table if not exists order_tags (id text primary key, order_id text not null, tag text not null, unique(order_id, tag));
create table if not exists inventory_ledger (id text primary key, product_id text not null, movement_type text not null, quantity integer not null, reference_type text, reference_id text, reason text not null, created_by text, created_at text not null);
create table if not exists confirmation_attempts (id text primary key, order_id text not null, user_id text not null, attempt_number integer not null default 1, outcome text not null, call_picked integer not null default 0, rejection_reason text, note text, callback_at text, next_action_at text, created_at text not null);
create table if not exists order_edit_requests (id text primary key, order_id text not null, requested_by text not null, field_name text not null, old_value text, new_value text not null, status text not null default 'PENDING', reviewed_by text, reviewed_at text, review_note text, created_at text not null);
create table if not exists campaigns (id text primary key, name text not null, description text, urgency text not null, assigned_agent_id text not null, criteria_json text, position integer not null default 0, created_by text not null, created_at text not null, is_active integer not null default 1);
create table if not exists campaign_assignments (id text primary key, campaign_id text not null, order_id text not null unique, assigned_agent_id text not null, position integer not null default 0, created_at text not null);
create table if not exists recall_cooldown_settings (id text primary key, default_hours integer not null, updated_by text not null, updated_at text not null);
create table if not exists recall_overrides (id text primary key, order_id text not null, overridden_by text not null, reason text not null, original_next_action_at text, new_next_action_at text not null, created_at text not null);
create table if not exists labels (id text primary key, order_id text not null, object_key text not null, file_name text not null, size integer not null, uploaded_by text not null, created_at text not null);
create table if not exists rto_tasks (id text primary key, order_id text not null, status text not null, outcome text, note text, completed_by text, completed_at text, created_at text not null);
create table if not exists webhook_receipts (id text primary key, provider text not null, topic text not null, received_at text not null);
create table if not exists integration_state (provider text primary key, status text not null, detail text, secret_value text, last_synced_at text, updated_at text not null);
create table if not exists integration_sync_cursors (provider text primary key, cursor_value text, full_backfill_complete integer not null default 0, last_success_at text, last_error text, updated_at text not null);
create table if not exists audit_events (id text primary key, actor_id text, action text not null, entity_type text not null, entity_id text not null, detail text, created_at text not null);
create table if not exists inventory_components (id text primary key, sku text not null unique, name text not null, component_type text not null, unit text not null default 'unit', rto_recoverable integer not null default 1, active integer not null default 1, created_at text not null, updated_at text not null);
create table if not exists component_ledger (id text primary key, component_id text not null, movement_type text not null, quantity integer not null, reference_type text, reference_id text, reason text not null, created_by text, created_at text not null);
create table if not exists packaging_profiles (id text primary key, name text not null, active integer not null default 1, created_at text not null);
create table if not exists recipe_versions (id text primary key, product_id text not null, version integer not null, status text not null, packaging_profile_id text not null, packing_units integer not null default 1, created_by text, created_at text not null, unique(product_id, version));
create table if not exists recipe_items (id text primary key, recipe_version_id text not null, component_id text not null, quantity integer not null);
create table if not exists packaging_box_options (id text primary key, profile_id text not null, component_id text not null, capacity integer not null, active integer not null default 1, unique(profile_id, component_id));
create table if not exists order_requirement_sets (order_id text primary key, status text not null, updated_at text not null);
create table if not exists order_requirements (id text primary key, order_id text not null, order_line_id text, component_id text not null, source text not null, required_quantity integer not null, allocated_quantity integer not null default 0, recipe_version_id text, created_at text not null);
create table if not exists packaging_plans (id text primary key, order_id text not null unique, status text not null, mixed_profile integer not null default 0, created_by text, updated_at text not null);
create table if not exists packaging_plan_lines (id text primary key, plan_id text not null, component_id text not null, quantity integer not null);
create table if not exists rto_qc_lines (id text primary key, task_id text not null, order_line_id text, good_quantity integer not null, damaged_quantity integer not null, created_at text not null);
create table if not exists component_types (code text primary key, name text not null unique, active integer not null default 1, created_at text not null);
create table if not exists manual_sales (id text primary key, reference text not null unique, product_id text not null, product_sku text not null, product_name text not null, quantity integer not null, status text not null, created_by text, created_at text not null, updated_at text not null);
create table if not exists manual_sale_components (id text primary key, sale_id text not null, component_id text not null, component_sku text not null, component_name text not null, quantity integer not null, rto_recoverable integer not null default 1);
create table if not exists shipment_events (id text primary key, order_id text, awb text not null, status text not null, status_code text, courier text, occurred_at text not null, received_at text not null);
create table if not exists shipments (id text primary key, order_id text not null, attempt_number integer not null default 1, shiprocket_order_id text, shiprocket_shipment_id text, awb_number text, courier_name text, courier_auto_cancel_days integer, auto_cancel_deadline text, status text not null, manifested_at text, label_url text, label_printed_at text, pickup_scheduled_at text, picked_up_at text, delivered_at text, auto_cancelled_at text, cancel_reason text, has_ndr integer not null default 0, is_active integer not null default 1);
create table if not exists tracking_events (id text primary key, shipment_id text, order_id text not null, event_tag text not null, event_description text, location text, event_timestamp text not null, received_at text not null, raw_payload text);
create table if not exists order_status_log (id text primary key, order_id text not null, from_status text, to_status text not null, changed_by text, reason text, notes text, created_at text not null);
create table if not exists courier_sla (id text primary key, courier_name text not null unique, auto_cancel_days integer not null, updated_by text, updated_at text not null);

create index if not exists orders_created_idx on orders(created_at);
create unique index if not exists orders_shopify_id_unique on orders(shopify_order_id) where shopify_order_id is not null;
create unique index if not exists orders_shiprocket_id_unique on orders(shiprocket_order_id) where shiprocket_order_id is not null;
create index if not exists order_lines_order_idx on order_lines(order_id);
create index if not exists order_tags_order_idx on order_tags(order_id);
create index if not exists order_tags_tag_idx on order_tags(tag);
create index if not exists confirmation_attempts_order_created_idx on confirmation_attempts(order_id, created_at);
create index if not exists campaign_assignments_campaign_idx on campaign_assignments(campaign_id);
create index if not exists campaign_assignments_agent_idx on campaign_assignments(assigned_agent_id);
create index if not exists campaigns_active_idx on campaigns(is_active);
create index if not exists campaigns_assigned_agent_idx on campaigns(assigned_agent_id);
create index if not exists order_edit_requests_order_idx on order_edit_requests(order_id);
create index if not exists order_edit_requests_status_idx on order_edit_requests(status);
create index if not exists component_ledger_component_idx on component_ledger(component_id);
create index if not exists order_requirements_order_idx on order_requirements(order_id);
create index if not exists order_requirements_component_idx on order_requirements(component_id);
create index if not exists manual_sale_components_sale_idx on manual_sale_components(sale_id);
create index if not exists shipment_events_order_idx on shipment_events(order_id);
create index if not exists shipment_events_awb_idx on shipment_events(awb);
create index if not exists shipment_events_occurred_idx on shipment_events(occurred_at);
create index if not exists shipments_order_idx on shipments(order_id);
create index if not exists shipments_awb_idx on shipments(awb_number);
create index if not exists shipments_active_idx on shipments(is_active);
create index if not exists tracking_events_shipment_idx on tracking_events(shipment_id);
create index if not exists tracking_events_order_idx on tracking_events(order_id);
create index if not exists tracking_events_timestamp_idx on tracking_events(event_timestamp);
create index if not exists order_status_log_order_idx on order_status_log(order_id);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'users','sessions','products','orders','order_lines','order_tags','inventory_ledger','confirmation_attempts',
    'order_edit_requests','campaigns','campaign_assignments','recall_cooldown_settings','recall_overrides','labels',
    'rto_tasks','webhook_receipts','integration_state','integration_sync_cursors','audit_events','inventory_components',
    'component_ledger','packaging_profiles','recipe_versions','recipe_items','packaging_box_options','order_requirement_sets',
    'order_requirements','packaging_plans','packaging_plan_lines','rto_qc_lines','component_types','manual_sales',
    'manual_sale_components','shipment_events','shipments','tracking_events','order_status_log','courier_sla'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end $$;

commit;
