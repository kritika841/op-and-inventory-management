ALTER TABLE `orders` ADD `shopify_customer_id` text;
--> statement-breakpoint
CREATE TABLE `order_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`tag` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_tags_order_tag_unique` ON `order_tags` (`order_id`,`tag`);
--> statement-breakpoint
CREATE INDEX `order_tags_order_idx` ON `order_tags` (`order_id`);
--> statement-breakpoint
CREATE INDEX `order_tags_tag_idx` ON `order_tags` (`tag`);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `assigned_agent_id` text NOT NULL DEFAULT 'usr_admin';
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `criteria_json` text;
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `position` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX `campaigns_assigned_agent_idx` ON `campaigns` (`assigned_agent_id`);
--> statement-breakpoint
ALTER TABLE `campaign_assignments` ADD `position` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `campaigns`
SET `assigned_agent_id` = COALESCE(
  (
    SELECT `assigned_agent_id`
    FROM `campaign_assignments`
    WHERE `campaign_id` = `campaigns`.`id`
    ORDER BY `created_at` ASC
    LIMIT 1
  ),
  `assigned_agent_id`
);
--> statement-breakpoint
UPDATE `campaigns`
SET `position` = (
  SELECT COUNT(*)
  FROM `campaigns` earlier
  WHERE earlier.`created_at` > `campaigns`.`created_at`
);
--> statement-breakpoint
UPDATE `campaign_assignments`
SET `position` = COALESCE(
  (
    SELECT COUNT(*)
    FROM `campaign_assignments` earlier
    WHERE earlier.`campaign_id` = `campaign_assignments`.`campaign_id`
      AND (
        earlier.`created_at` < `campaign_assignments`.`created_at`
        OR (earlier.`created_at` = `campaign_assignments`.`created_at` AND earlier.`id` <= `campaign_assignments`.`id`)
      )
  ) - 1,
  0
);
