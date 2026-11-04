import { CodexAuth } from "../src/auth";
import { loadConfig } from "../src/config";
import { CodexProvider } from "../src/provider";

const auth = new CodexAuth(loadConfig().codexHome);
try {
  const { snapshot, creditsError } = await new CodexProvider(auth).read();
  console.log(
    JSON.stringify(
      {
        fiveHour: snapshot.fiveHour,
        weekly: snapshot.weekly,
        availableResets:
          snapshot.credits?.filter((credit) => credit.status === "available")
            .length ?? null,
        creditsError,
      },
      null,
      2,
    ),
  );
  if (creditsError) process.exitCode = 1;
} catch {
  console.error("source check failed; verify codex login and network access");
  process.exitCode = 1;
} finally {
  auth.close();
}
