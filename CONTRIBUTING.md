# Contributing to Manifest Node.js SDK

Thanks for your interest in contributing to the Manifest Node.js SDK!

## Prerequisites

- Node.js 22+
- npm 10+

## Getting Started

1. Fork and clone the repository:

```bash
git clone https://github.com/<your-username>/manifest-node.git
cd manifest-node
npm install
```

## Development

```bash
npm run dev     # Watch and rebuild on changes
npm run build   # Production build
npm test        # Run tests
```

## Making Changes

1. Create a branch from `main` for your change
2. Make your changes
3. Run tests to make sure everything passes
4. Write clear commit messages using conventional commits (e.g., `feat:`, `fix:`, `docs:`)
5. Open a pull request against `main`

## Commit Messages

Use conventional commit titles:
- `feat:` for new features (prepares a minor version)
- `fix:` for bug fixes (prepares a patch version)
- `docs:` for documentation changes
- `!` or `BREAKING CHANGE:` for breaking changes (prepares a major version)

## Supported Platforms

The SDK works with:
- Built-in `fetch`
- `node:http` and `node:https`
- Axios
- TypeScript, ESM and CommonJS
- Zero dependencies

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
