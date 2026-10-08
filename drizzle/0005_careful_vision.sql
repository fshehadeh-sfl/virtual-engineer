DROP INDEX `uq_posted_review_comments_task_hash`;--> statement-breakpoint
ALTER TABLE `posted_review_comments` ADD `provider_comment_url` text;--> statement-breakpoint
ALTER TABLE `posted_review_comments` ADD `disposition` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_posted_review_comments_task_active_hash` ON `posted_review_comments` (`task_id`,`comment_hash`) WHERE "posted_review_comments"."resolved" = 0;