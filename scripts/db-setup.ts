/** Create the read-only role and grants (after db:migrate): npm run db:setup */
import { requireUrl } from "../lib/db/config";
import { setupRoles } from "../lib/db/setup";

setupRoles(requireUrl("admin"), requireUrl("readonly"))
  .then(({ role }) => console.log(`Read-only role "${role}" is ready.`))
  .catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
