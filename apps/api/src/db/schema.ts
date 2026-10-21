import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { ulid } from "ulid";

export const channelMemberRole = pgEnum("channel_member_role", ["admin", "member"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    displayName: varchar("display_name", { length: 80 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_lower_unique").on(sql`lower(${table.email})`)],
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    isPrivate: boolean("is_private").notNull().default(false),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (table) => [uniqueIndex("channels_name_unique").on(table.name)],
);

export const messages = pgTable(
  "messages",
  {
    id: varchar("id", { length: 26 }).$defaultFn(() => ulid()).primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    clientMessageId: varchar("client_message_id", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "messages_body_nonempty_max_length_check",
      sql`char_length(regexp_replace(${table.body}, '^[[:space:]]+|[[:space:]]+$', '', 'g')) > 0 AND char_length(${table.body}) <= 4000`,
    ),
    uniqueIndex("messages_user_client_message_unique").on(table.userId, table.clientMessageId),
    index("messages_channel_id_id_desc_idx").on(table.channelId, table.id.desc()),
    index("messages_channel_unread_idx")
      .on(table.channelId, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const channelMembers = pgTable(
  "channel_members",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: channelMemberRole("role").notNull().default("member"),
    lastReadMessageId: varchar("last_read_message_id", { length: 26 }).references(
      () => messages.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.userId], name: "channel_members_pkey" }),
    index("channel_members_user_unread_idx").on(
      table.userId,
      table.channelId,
      table.lastReadMessageId,
    ),
  ],
);
