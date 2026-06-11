import { createDb } from "./db.js";
import { createServer } from "./server.js";

const db = createDb("shopette.db");
const app = createServer(db);
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
	console.log(`shopette listening on :${port}`);
});
