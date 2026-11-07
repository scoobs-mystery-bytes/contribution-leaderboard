# Contributing

Thanks for helping make Contribution Leaderboard better! Bug reports, ideas, documentation, and code are all welcome.

## Get started

1. Fork and clone the repository.
2. Install Node.js 24 and npm.
3. Install dependencies and run the checks:

   ```sh
   npm ci
   npm run check
   ```

`npm run check` type-checks the code, rebuilds the action bundle, and runs the tests. Tests use mock GitHub and Discord responses; they do not post to Discord.

## Make a change

1. Create a branch for your change.
2. Update the relevant source, documentation, or tests. Add tests when they help verify a meaningful behavior change.
3. Run `npm run check` and commit the rebuilt `dist/index.cjs` with source changes. The action loads its Discord thumbnail from `assets/images/contribution-leaderboard-logo.png`, so include that file in distributions.
4. Open a pull request describing the change and how you checked it.

Useful commands:

```sh
npm run typecheck
npm test
npm run build
```

The [design document](docs/design.md) explains scoring, scheduling, Discord delivery, and their limitations. For an end-to-end check, follow the [live test instructions](README.md#live-test); use a dedicated test channel and keep the webhook URL in a GitHub Actions secret.

Posting cadence and the score window are separate inputs. When changing either, check the completed, daily, weekly, multi-week, monthly, and all-time windows against the UTC boundary behavior described in the [setup guide](README.md#posting-schedule-and-score-window). The example live-test workflow defaults to the previous completed week.

## License

Contributions are provided under the [MIT License](LICENSE).
