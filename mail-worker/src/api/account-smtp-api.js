import app from '../hono/hono';
import accountSmtpService from '../service/account-smtp-service';
import result from '../model/result';
import userContext from '../security/user-context';

app.get('/account/smtp', async (c) => {
	const data = await accountSmtpService.getStatus(c, c.req.query().accountId, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.put('/account/smtp', async (c) => {
	const data = await accountSmtpService.upsert(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.put('/account/smtp/status', async (c) => {
	const data = await accountSmtpService.setStatus(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.delete('/account/smtp', async (c) => {
	const data = await accountSmtpService.revoke(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(data));
});
