# Balancer

A browser-based learning demo that makes load-balancer decisions visible. It includes a conceptual worker pool, a round-robin router, and a least-outstanding-requests router. Each view shows request routing, target availability, activity, and cards explaining the model.

The app runs entirely in the browser. It does not start operating-system workers, call AWS, or reproduce every detail of an AWS Application Load Balancer.

## Run locally

Requires Node.js 18 or newer.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite (normally `http://localhost:5173`). No cloud account or backend is needed.

To create and inspect a production build locally:

```sh
npm run build
npm run preview
```

## Demos

### Conceptual worker pool

- Choose 1–12 workers and a processing-time range. Worker count changes immediately; reset clears the run.
- Send requests manually or start automatic traffic at a configurable rate from 0.1 to 20 requests per second (default 1).
- Workers publish idle/busy status, or the balancer can poll as it scans. Routing uses round-robin order, skips busy or unhealthy workers, and queues requests FIFO when no worker is available.
- If a worker becomes unhealthy during a request, that active request continues. The worker stops receiving new work until its outage ends.

### Round robin

Routes each request to the next healthy target in rotation, regardless of its in-flight request count. This is easiest to understand when targets have similar capacity and requests have similar duration.

### Least outstanding requests

Routes each request to a healthy target with the fewest requests currently in flight. Ties rotate to distribute work fairly. A request is treated as in flight for the configured processing duration.

Both target-routing views use the same target health-check model. The demo accelerates checks to once every 2.5 seconds and uses a threshold of two consecutive failures or successes. The **Simulate endpoint failure** control demonstrates that health-check flow; restoring the endpoint lets checks mark it healthy again.

## Simulated failures

All three demos include **Failure chance** and minimum/maximum outage-duration controls. The chance is checked independently for each currently healthy worker or target once per second. A selected outage marks that worker or target unhealthy for a random duration in the chosen range. It is then returned to the healthy pool automatically. A random outage only changes whether new requests can be routed there; requests already in progress continue.

Set the chance to **0%** to turn off random failures, or **100%** to force each healthy worker/target to fail on its next per-second check. A higher percentage increases the chance of an outage; it does not guarantee a failure at an exact time unless set to 100%.

The random outage control is a teaching aid, not the same mechanism as ALB health checks. The target demos keep their separate simulated health checks visible so the two ideas can be compared.

## Controls shared by the demos

- **Processing time:** sets the random duration assigned to new requests. Existing work keeps its current duration.
- **Auto req/s:** sets automatic request rate; changing it updates a running interval.
- **Failure chance and outage duration:** changes simulated target availability without cancelling in-flight work.
- **Reset:** clears the active simulation. Configuration values remain selected.
- **Dark mode:** switches the interface theme.

## GitHub Pages

The repository includes a GitHub Actions workflow that builds the Vite app and deploys the `dist/` output. For this repository, the expected project-site URL is <https://ardathepolat.github.io/load-balancer-demo/>.

After pushing the repository to GitHub:

1. Open **Settings → Pages** in the repository.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Run the **Deploy GitHub Pages** workflow from **Actions**, or push another commit to `main`.
4. Open the site URL shown in the workflow's `github-pages` deployment environment.

GitHub Pages is available for public repositories on GitHub Free. Private-repository Pages availability depends on the account or organization plan. The published site is public to visitors.

## Project structure

- `src/App.tsx` — conceptual simulation, tabs, and learning cards.
- `src/RoutingDemo.tsx` — shared target-routing implementation for round robin and least outstanding requests.
- `src/*.css` — app, topology, queue, and target-routing styles.
- `.github/workflows/deploy-pages.yml` — Pages build and deployment workflow.

## Local verification

```sh
npm run build
```
