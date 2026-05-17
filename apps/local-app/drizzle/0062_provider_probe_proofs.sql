CREATE TABLE `provider_probe_proofs` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`bin_path` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
