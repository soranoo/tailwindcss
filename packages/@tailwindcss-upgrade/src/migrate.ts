import fs from 'node:fs/promises'
import path from 'node:path'
import postcss, { AtRule } from 'postcss'
import type { Config } from 'tailwindcss'
import type { DesignSystem } from '../../tailwindcss/src/design-system'
import { segment } from '../../tailwindcss/src/utils/segment'
import { migrateAtApply } from './codemods/migrate-at-apply'
import { migrateAtLayerUtilities } from './codemods/migrate-at-layer-utilities'
import { migrateMissingLayers } from './codemods/migrate-missing-layers'
import { migrateTailwindDirectives } from './codemods/migrate-tailwind-directives'
import { resolveCssId } from './utils/resolve'
import { walk, WalkAction } from './utils/walk'

export interface MigrateOptions {
  newPrefix?: string
  designSystem?: DesignSystem
  userConfig?: Config
}

export interface Stylesheet {
  file?: string
  unlink?: boolean

  rootFile?: string
  rootImport?: postcss.AtRule

  content?: string | null
  root?: postcss.Root | null
  layers?: Set<string>

  parents?: Set<Stylesheet>
  importRules?: Set<AtRule>

  readonly ancestors?: Set<Stylesheet>
}

export async function migrateContents(
  stylesheet: Stylesheet | string,
  options: MigrateOptions = {},
) {
  if (typeof stylesheet === 'string') {
    stylesheet = {
      content: stylesheet,
      root: postcss.parse(stylesheet),
    }
  }

  console.log(stylesheet.file)
  console.log(stylesheet.root!.toString())

  return postcss()
    .use(migrateAtApply(options))
    .use(migrateAtLayerUtilities(stylesheet))
    .use(migrateMissingLayers())
    .use(migrateTailwindDirectives(options))
    .process(stylesheet.root!, { from: stylesheet.file })
}

export async function migrate(stylesheet: Stylesheet, options: MigrateOptions) {
  if (!stylesheet.file) {
    throw new Error('Cannot migrate a stylesheet without a file path')
  }

  await migrateContents(stylesheet, options)
}

export async function analyze(stylesheets: Stylesheet[]) {
  let mediaWrapper = `__wrapper__${Math.random().toString(16).slice(3, 8)}__`

  let stylesheetsByFile = new Map<string, Stylesheet>()
  for (let stylesheet of stylesheets) {
    if (!stylesheet.file) continue
    stylesheetsByFile.set(stylesheet.file, stylesheet)

    stylesheet.layers ??= new Set()
    stylesheet.importRules ??= new Set()
    stylesheet.parents ??= new Set()

    Object.defineProperty(stylesheet, 'ancestors', {
      get: () => {
        function* ancestors(sheet: Stylesheet): Iterable<Stylesheet> {
          for (let parent of sheet.parents ?? []) {
            yield parent
            yield* ancestors(parent)
          }
        }

        return new Set(ancestors(stylesheet))
      },
    })
  }

  // A list of all marker nodes used to annotate and analyze the AST
  let importMarkers = new Set<postcss.Node>()
  let fileMarkers = new Set<postcss.Node>()

  // Step 1: Record which `@import` rules point to which stylesheets
  // and which stylesheets are parents/children of each other
  let processor = postcss([
    {
      postcssPlugin: 'mark-import-nodes',
      AtRule: {
        import(node) {
          // Find what the import points to
          let id = node.params.match(/['"](.*)['"]/)?.[1]
          if (!id) return

          let basePath = node.source?.input.file
            ? path.dirname(node.source.input.file)
            : process.cwd()

          // Resolve the import to a file path
          let resolvedPath: string | false
          try {
            resolvedPath = resolveCssId(id, basePath)
          } catch (err) {
            console.warn(`Failed to resolve import: ${id}. Skipping.`)
            console.error(err)
            return
          }

          if (!resolvedPath) return

          // Find the stylesheet pointing to the resolved path
          let stylesheet = stylesheetsByFile.get(resolvedPath)

          // If it _does not_ exist in stylesheets we don't care and skip it
          // this is likely because its in node_modules or a workspace package
          // that we don't want to modify
          if (!stylesheet) return

          // If it does then this import node get added to that sylesheets `importRules` set
          let parent = stylesheetsByFile.get(node.source?.input.file ?? '')
          if (!parent) return

          // Record the import node for this sheet so it can be modified later
          stylesheet.importRules!.add(node)

          // Connect all stylesheets together in a dependency graph
          // The way this works is it uses the knowledge that we have a list of
          // the `@import` nodes that cause a given stylesheet to be imported.
          // That import has a `source` pointing to parent stylesheet's file path
          // which can be used to look it up
          stylesheet.parents!.add(parent)

          for (let part of segment(node.params, ' ')) {
            if (!part.startsWith('layer(')) continue
            if (!part.endsWith(')')) continue

            stylesheet.layers!.add(part.slice(6, -1).trim())
          }
        },
      },
    },
  ])

  for (let sheet of stylesheets) {
    if (!sheet.file) continue
    if (!sheet.root) continue

    await processor.process(sheet.root, { from: sheet.file })
  }

  // Step 2: Analyze the AST so each stylesheet can know what layers it is inside
  for (let sheet of stylesheets) {
    for (let ancestor of sheet.ancestors ?? []) {
      for (let layer of ancestor.layers ?? []) {
        sheet.layers!.add(layer)
      }
    }
  }
}

export async function prepare(stylesheet: Stylesheet) {
  if (stylesheet.file) {
    stylesheet.file = path.resolve(process.cwd(), stylesheet.file)
    stylesheet.content = await fs.readFile(stylesheet.file, 'utf-8')
  }

  if (stylesheet.content) {
    stylesheet.root = postcss.parse(stylesheet.content, {
      from: stylesheet.file,
    })
  }
}

export async function split(stylesheets: Stylesheet[]) {
  let utilitySheets = new Map<Stylesheet, Stylesheet>()
  let newRules: postcss.AtRule[] = []

  for (let sheet of stylesheets.slice()) {
    if (!sheet.root) continue
    if (!sheet.file) continue

    // We only care about stylesheets that were imported into a layer e.g. `layer(utilities)`
    let isLayered = sheet.layers?.has('utilities') || sheet.layers?.has('components')
    if (!isLayered) continue

    // We only care about stylesheets that contain an `@utility`
    let hasUtilities = false

    walk(sheet.root, (node) => {
      if (node.type !== 'atrule') return
      if (node.name !== 'utility') return

      hasUtilities = true

      return WalkAction.Stop
    })

    console.log(sheet.file)
    console.log(sheet.root.toString())

    if (!hasUtilities) continue

    // Split the stylesheet into two parts: one with the utilities and one without
    let utilities = postcss.root({
      raws: {
        tailwind_pretty: true,
      },
    })

    walk(sheet.root, (node) => {
      if (node.type !== 'atrule') return
      if (node.name !== 'utility') return

      utilities.append(node)

      return WalkAction.Skip
    })

    // Add the import for the new utility file immediately following the old import
    for (let node of sheet.importRules ?? []) {
      // This node didn't have a `layer(…)` yet, but we added one during the
      // migration. This means that we don't have to consider this node for the
      // new import rule.
      if (node.raws.tailwind_injected_layer) {
        continue
      }

      // Only interested in the main import rule with the layer
      // if (!node.params.includes('layer(utilities)') && !node.params.includes('layer(components)')) {
      //   continue
      // }

      // if (node !== sheet.rootImport) {
      //   continue
      // }

      // We want to use the name of the main import, not the name of the
      // transitive import.
      //
      // ```css
      // /* index.css */
      // @import "./a.css" layer(utilities);
      //
      // /* a.css */
      // @import "./b.css";
      //
      // /* b.css */
      // @layer utilities {
      //   .foo {}
      // }
      // ```
      //
      // In this case we want `a.utilities.css` to be the name of the new file,
      // not `b.utilities.css`. Every `@layer utilities` directive will be
      // converted to `@utility` and will be hoisted to the `a.utilities.css`
      // file.

      let relativePath = /['"](.*?)['"]/g.exec(node.params)
      if (!relativePath) continue // This should never happen
      if (!node.source?.input.file) continue // This should never happen

      let name = path.basename(relativePath[1])

      let utilitySheet: Stylesheet = {
        file: path.join(path.dirname(sheet.file!), name.replace(/\.css$/, '.utilities.css')),
        root: utilities,
      }

      utilitySheets.set(sheet, utilitySheet)

      // Figure out the new import rule
      let newParams = node.params.replace(/\.css(['"])/, '.utilities.css$1')
      console.log(newParams)

      // Only add the new `@import` at-rule if it doesn't exist yet.
      let existingNewImport = newRules.find((rule) => rule.params === newParams)
      if (!existingNewImport) {
        newRules.push(
          node.cloneAfter({
            params: newParams,
            raws: {
              after: '\n\n',
              tailwind_pretty: true,
            },
          }),
        )
      }
    }
  }

  console.dir(
    [
      ...Array.from(stylesheets.slice(), (s) => [
        s.file,
        Array.from(s.importRules ?? [], (r) => r.toString()),
      ]),
      Array.from(utilitySheets.values(), (s) => s.file),
    ],
    { depth: 1 },
  )

  // Merge utility sheets.
  // It could be that the same type of file is created from two different
  // locations. In this case, the final file will exist twice.
  // E.g.:
  //
  // ```css
  // /* index.css*/
  // @import './a.css' layer(utilities);
  //
  // /* a.css */
  // @import './b.css';
  // .foo {}            /* <- generates a.utilities.css, key points to a.css */
  //
  // /* b.css */
  // .bar {}            /* <- generates a.utilities.css, key points to b.css */
  // ```
  let mergedUtilitySheets = new Map<string, Stylesheet>()
  for (let utilitySheet of utilitySheets.values()) {
    if (!utilitySheet.file) continue // Should never happen

    let existing = mergedUtilitySheets.get(utilitySheet.file)
    if (!existing) {
      mergedUtilitySheets.set(utilitySheet.file, utilitySheet)
    } else {
      // TODO: Not sure why a `prepend` is required instead of an `append`, but
      // this results in the correct order.
      existing.root?.prepend(utilitySheet.root?.nodes ?? [])
    }
  }

  // The new import rules should have just the filename import
  // no layers, media queries, or anything else
  for (let node of newRules) {
    node.params = segment(node.params, ' ')[0]
  }

  for (let [originalSheet, utilitySheet] of utilitySheets) {
    utilitySheet.parents = new Set(
      Array.from(originalSheet.parents ?? []).map((parent) => {
        return utilitySheets.get(parent) ?? parent
      }),
    )
  }

  stylesheets.push(...mergedUtilitySheets.values())

  // At this point, we probably created `{name}.utilities.css` files. If the
  // original `{name}.css` is empty, then we can optimize the output a bit more
  // by re-using the original file but just getting rid of the `layer
  // (utilities)` marker.
  // If removing files means that some `@import` at-rules are now unnecessary, we
  // can also remove those.
  {
    // 1. Get rid of empty files (and their imports)
    let repeat = true
    while (repeat) {
      repeat = false
      for (let stylesheet of stylesheets) {
        // Was already marked to be removed, skip
        if (stylesheet.unlink) continue

        // Original content was not empty, but the new content is. Therefore we
        // can mark the file for removal.
        // TODO: Make sure that empty files are not even part of `stylesheets`
        //       in the first place. Then we can get rid of this check.
        if (stylesheet.content?.trim() !== '' && stylesheet?.root?.toString().trim() === '') {
          repeat = true
          stylesheet.unlink = true

          // Cleanup imports that are now unnecessary
          for (let parent of stylesheet.importRules ?? []) {
            parent.remove()
          }
        }
      }
    }

    // 2. Use `{name}.css` instead of `{name}.utilities.css` if the `{name}.css`
    //    was marked for removal.
    for (let [originalSheet, utilitySheet] of utilitySheets) {
      // Original sheet was marked for removal, use the original file instead.
      if (!originalSheet.unlink) continue

      // Fixup the import rule
      for (let parent of originalSheet.importRules ?? []) {
        parent.params = parent.params.replace(/\.utilities\.css(['"])/, '.css$1')
      }

      // Fixup the file path
      // utilitySheet.file = utilitySheet.file?.replace(/\.utilities\.css$/, '.css')
      console.log('Cleanup', utilitySheet.file)
    }
  }
}

// @import './a.css' layer(utilities) ;
//   -> @utility { … }

// @import './a.css' layer(utilities);
//  -> @import './b.css';
//    -> @import './c.css';
//       -> .utility-class
//       -> #main
//    -> other stuff
//  -> other stuff

// @import './a.css' layer(utilities);
//  -> @import './b.css'; (layers: utilities)
//    -> @import './c.css';
//      -> @import './d.css';
//         -> #main
//    -> other stuff
