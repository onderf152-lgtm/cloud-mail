import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const accountSmtp = sqliteTable('account_smtp', {
	accountId: integer('account_id').primaryKey(),
	smtpHost: text('smtp_host').notNull().default(''),
	smtpPort: integer('smtp_port').notNull().default(465),
	smtpUser: text('smtp_user').notNull(),
	passCipher: text('pass_cipher').notNull(),
	passIv: text('pass_iv').notNull(),
	keyVer: integer('key_ver').notNull().default(1),
	status: integer('status').notNull().default(1),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull()
});

export const accountSmtpConst = {
	status: {
		ACTIVE: 1,
		DISABLED: 2
	}
};

export default accountSmtp;
