CREATE TABLE `component_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`component_id` text NOT NULL,
	`movement_type` text NOT NULL,
	`quantity` integer NOT NULL,
	`reference_type` text,
	`reference_id` text,
	`reason` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inventory_components` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`component_type` text NOT NULL,
	`unit` text DEFAULT 'unit' NOT NULL,
	`rto_recoverable` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_components_sku_unique` ON `inventory_components` (`sku`);--> statement-breakpoint
CREATE TABLE `order_requirement_sets` (
	`order_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`order_line_id` text,
	`component_id` text NOT NULL,
	`source` text NOT NULL,
	`required_quantity` integer NOT NULL,
	`allocated_quantity` integer DEFAULT 0 NOT NULL,
	`recipe_version_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `packaging_box_options` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`component_id` text NOT NULL,
	`capacity` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packaging_box_profile_component_unique` ON `packaging_box_options` (`profile_id`,`component_id`);--> statement-breakpoint
CREATE TABLE `packaging_plan_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`component_id` text NOT NULL,
	`quantity` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `packaging_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`status` text NOT NULL,
	`mixed_profile` integer DEFAULT false NOT NULL,
	`created_by` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packaging_plans_order_unique` ON `packaging_plans` (`order_id`);--> statement-breakpoint
CREATE TABLE `packaging_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recipe_items` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_version_id` text NOT NULL,
	`component_id` text NOT NULL,
	`quantity` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recipe_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`packaging_profile_id` text NOT NULL,
	`packing_units` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_product_version_unique` ON `recipe_versions` (`product_id`,`version`);--> statement-breakpoint
CREATE TABLE `rto_qc_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`order_line_id` text,
	`good_quantity` integer NOT NULL,
	`damaged_quantity` integer NOT NULL,
	`created_at` text NOT NULL
);
