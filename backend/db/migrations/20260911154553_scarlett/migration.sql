CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"content" text NOT NULL,
	"guestName" varchar(255),
	"guestEmail" varchar(255),
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"pageId" uuid NOT NULL,
	"siteId" uuid NOT NULL,
	"authorId" uuid
);
--> statement-breakpoint
CREATE INDEX "comments_page_created_idx" ON "comments" ("pageId","createdAt");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL;