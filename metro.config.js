const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

/*
 * Resolve packages through their CommonJS entry, not their ESM one.
 *
 * `fast-xml-parser` 5.x is `"type": "module"` and its ESM source
 * (`src/fxp.js`) uses relative imports that Node's ESM resolver accepts but
 * Metro does not — bundling fails with
 *   Unable to resolve "./validator.js" from "fast-xml-parser/src/fxp.js"
 * even though the file is present. The package ships a working CJS build
 * (`lib/fxp.cjs`, exporting XMLParser/XMLBuilder/XMLValidator); dropping
 * 'import' from the condition list makes Metro pick it.
 *
 * `unstable_enablePackageExports` stays on — it is the default in SDK 57 and
 * other dependencies rely on it. Only the condition *order* changes.
 */
config.resolver.unstable_conditionNames = ['require', 'react-native', 'default']

module.exports = config
