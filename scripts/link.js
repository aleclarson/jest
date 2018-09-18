const AsyncTaskGroup = require('async-task-group')
const exec = require('exec')
const huey = require('huey')
const path = require('path')
const fs = require('saxon/sync')

// Number of processed packages
let progress = 0

// Jest packages
const packages = fs.list('packages')
  .filter(name => fs.isDir('packages/' + name))

// Package queue
const queue = new AsyncTaskGroup(3, process)
queue.concat(packages)

function process(name) {
  const pkg = path.resolve('packages/' + name)
  console.log(huey.yellow('>>'), pkg)

  let metaStr = fs.read(pkg + '/package.json')
  let meta = JSON.parse(metaStr)
  
  let deps = meta.dependencies
  if (deps) localize(deps)

  deps = meta.devDependencies
  if (deps) localize(deps)

  let space = /\s*$/.exec(metaStr)
  space = space ? space[0] : ''

  metaStr = JSON.stringify(meta, null, 2) + space
  fs.write(pkg + '/package.json', metaStr)
  console.log(huey.coal(metaStr))

  let printed = false
  let countRE = /total (\d+)/

  // Install dependencies
  fs.remove(pkg + '/node_modules', true)
  return exec.async('pnpm install', {
    cwd: pkg,
    listener(err, data) {
      if (err) return console.error(err)
      if (printed) return

      const count = countRE.exec(data)
      if (count) {
        printed = true
        console.log(name + ':', huey.cyan(count[1] + ' dependencies to install'))
      }
    }
  }).then(() => {
    let n = ++progress
    let len = packages.length
    let prct = (100 * n / len).toFixed(1)
    console.log(name + ':', huey.green(n), `/ ${len}`, huey.gray(`(${prct}%)`))
  })
}

function localize(deps) {
  for (let key in deps) {
    if (packages.includes(key)) {
      deps[key] = 'file:../' + key
    }
  }
}
