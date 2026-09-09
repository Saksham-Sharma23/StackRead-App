/*
 * `./src/ui/perf` is imported first, and the order is load-bearing.
 *
 * ES imports are evaluated in source order, and that module imports nothing of
 * its own — so its module scope runs before `expo` and `./App` and everything
 * App reaches. The difference between that moment and the body of this file is
 * our graph's evaluation cost, which is the figure R2-1 and R2-2 exist to
 * reduce.
 *
 * Move this below `./App` and it measures nothing.
 */
import { noteBundleEval } from './src/ui/perf'

import { registerRootComponent } from 'expo';

import App from './App';

noteBundleEval()

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
