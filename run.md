# Build (TS -> JS)
npm run build

# Run
npm start

# Dev
npm run dev

# Watch
npm run watch

# Windows APPX (Microsoft Store) x64 & arm64
npm run build:msstore:x64
npm run build:msstore:arm64
npm run build:msstore  # Both architectures

# Update License:
npx npm-license-crawler --production --json licenses.json