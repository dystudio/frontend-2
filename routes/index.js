'use strict'

const fs = require('fs')
const path = require('path')
const urllib = require('url')

const express = require('express')
const sm = require('sitemap')
const fetch = require('node-fetch')
const bytes = require('bytes')
const fm = require('front-matter')
const moment = require('moment')
const md5 = require('md5')
const timeago = require('timeago.js')
const puppeteer = require('puppeteer')
const mcache = require('memory-cache')
const slash = require('slash')
const wpcom = require('wpcom')()

var stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const ua = require('universal-analytics')

const config = require('../config')
const lib = require('../lib')
const utils = require('../lib/utils')
const keywords = require('../public/seo/keywords.json')

const datapackage = require('datapackage')

module.exports = function () {
  // eslint-disable-next-line new-cap
  const router = express.Router()
  const api = new lib.DataHubApi(config)

  // Function for caching responses:
  const cache = (duration) => {
    return (req, res, next) => {
      let key = '__express__' + req.originalUrl || req.url
      let cachedBody = mcache.get(key)
      if (cachedBody) {
        res.send(cachedBody)
        return
      } else {
        res.sendResponse = res.send
        res.send = (body) => {
          mcache.put(key, body, duration * 60000)
          res.sendResponse(body)
        }
        next()
      }
    }
  }

  // Front page:
  router.get('/', async (req, res) => {
    res.render('home.html', {
      title: 'Home'
    })
  })

  // Sitemap:
  router.get('/sitemap.xml', async (req, res) => {
    // Create sitemap object with existing static paths:
    const sitemap = sm.createSitemap({
      host: 'https://datahub.io',
      cacheTime: 600000,
      urls: router.stack.reduce((urls, route) => {
        const pathToIgnore = [
          '/pay', '/pay/checkout', '/thanks', '/logout',
          '/success', '/user/login', '/sitemap.xml', '/dashboard'
        ]
        if (
          route.route.path.constructor.name == 'String'
          && !route.route.path.includes(':')
          && !pathToIgnore.includes(route.route.path)
        ) {
          urls.push({
            url: urllib.resolve('https://datahub.io', route.route.path),
            changefreq: 'monthly'
          })
        }
        return urls
      }, [])
    })
    // Include additional path, e.g., blog posts, awesome pages, docs:
    const leftoverPages = [
      '/awesome/football', '/awesome/climate-change', '/awesome/linked-open-data',
      '/awesome/war-and-peace', '/awesome/world-bank', '/awesome/economic-data',
      '/awesome/reference-data', '/awesome/machine-learning-data', '/awesome/inflation',
      '/awesome/property-prices', '/awesome/wealth-income-and-inequality', '/awesome/logistics-data',
      '/awesome/demographics', '/awesome/education', '/awesome/geojson',
      '/awesome/healthcare-data', '/awesome/stock-market-data',
      '/docs', '/docs/getting-started/installing-data', '/docs/getting-started/publishing-data',
      '/docs/getting-started/push-excel', '/docs/getting-started/getting-data',
      '/docs/getting-started/how-to-use-info-cat-and-get-commands-of-data-tool',
      '/docs/getting-started/datapackage-find-prepare-share-guide', '/docs/automation',
      '/docs/tutorials/js-sdk-tutorial', '/docs/tutorials/auto-publish-your-datasets-using-travis-ci',
      '/docs/features/data-cli', '/docs/features/views', '/docs/features/preview-tables-for-your-data',
      '/docs/features/auto-generated-csv-json-and-zip', '/docs/features/api',
      '/docs/core-data', '/docs/core-data/curators', '/docs/core-data/curators-guide',
      '/docs/data-packages', '/docs/data-packages/tabular', '/docs/data-packages/csv',
      '/docs/data-packages/publish', '/docs/data-packages/publish-any',
      '/docs/data-packages/publish-faq', '/docs/data-packages/publish-geo',
      '/docs/data-packages/publish-online', '/docs/data-packages/publish-tabular',
      '/docs/misc/markdown', '/docs/faq'
    ]
    fs.readdirSync('blog/').forEach(post => {
      leftoverPages.push(`blog/${post.slice(11, -3)}`)
    })
    leftoverPages.forEach(page => {
      sitemap.add({url: urllib.resolve('https://datahub.io', page)})
    })
    // Add special users' publisher pages and their datasets:
    const specialUsers = ['core', 'machine-learning', 'examples', 'world-bank', 'five-thirty-eight', 'sports-data', 'cryptocurrency', 'unece']
    await Promise.all(specialUsers.map(async user => {
      sitemap.add({url: urllib.resolve('https://datahub.io', user)})
      let packages = await api.search(`datahub.ownerid="${user}"&size=100`)
      packages.results.forEach(pkg => sitemap.add({url: urllib.resolve('https://datahub.io', pkg.id)}))
      let total = packages.summary.total
      total -= 100
      let from = 1
      while (total > 0) {
        from += 100
        packages = await api.search(`datahub.ownerid="${user}"&size=100&from=${from}`)
        packages.results.forEach(pkg => sitemap.add({url: urllib.resolve('https://datahub.io', pkg.id)}))
        total -= 100
      }
    }))
    // Generate sitemap object into XML and respond:
    sitemap.toXML((err, xml) => {
      if (err) {
        console.log(err)
        return res.status(500).end();
      }
      res.header('Content-Type', 'application/xml')
      res.send( xml )
    })
  })

  // ----------------------------
  // Redirects

  function redirectToDest(dest) {
    return (req, res) => {
      res.redirect(301, dest)
    }
  }

  // Redirects Old data-os page to new data-factory:
  router.get('/docs/data-os', (req, res) => {
    res.redirect(301, '/data-factory')
  })

  // rename download to tools 2019-01-30
  router.get([
    '/download'
  ], redirectToDest('/tools'))

  router.get('/api-guides', redirectToDest('/guide/api'))
  router.get('/simple-guides', redirectToDest('/guide/simple'))

  // EDS specific:
  router.get(['/news', '/guide'], listStaticPages)

  async function listStaticPages(req, res) {
    const blog = wpcom.site('edscms.home.blog')
    // Get latest 10 blog posts
    const result = await blog.postsList({number: 10})
    res.render('blog.html', {
      posts: result.posts
    })
  }

  router.get(['/about', '/guide/:page', '/news/:page'], showStaticPage)

  async function showStaticPage(req, res, next) {
    const blog = wpcom.site('edscms.home.blog')
    // Get the post using slug
    blog.post({slug: req.params.page}).getBySlug((err, data) => {
      if (err) {
        next(err)
      } else {
        res.render('static.html', {
          title: data.title,
          content: data.content,
          published: moment(data.date).format('MMMM Do, YYYY'),
          modified: moment(data.modified).format('MMMM Do, YYYY'),
        })
      }
    })
  }

  router.get('/dataset', async (req, res, next) => {
    // Get the list of datasets:
    const apiPath = 'http://127.0.0.1:5000/api/3/action/current_package_list_with_resources'
    const response = await fetch(apiPath)
    if (response.status === 200) {
      const packages = await response.json()
      packages.summary = {total: 34}
      res.render('search.html', {
        title: 'Search Datasets',
        description: 'Search for public datasets. Quickly find data in various formats: csv, json, excel and more.',
        packages,
        defaultSearch: false
      })
    }
  })

  router.get('/dashboard', async (req, res, next) => {
    if (req.cookies.jwt) {
      const isAuthenticated = await api.authenticate(req.cookies.jwt)
      if (isAuthenticated) {
        // This is for tracking:
        const client = req.session.client || 'dashboard-check'

        const userProfile = await api.getProfile(req.cookies.username)
        if (!userProfile.found) {
          res.status(404).render('404.html', {
            message: 'Sorry, this page was not found'
          })
          return
        }
        const avatar = userProfile.profile.avatar_url || `https://www.gravatar.com/avatar/${userProfile.profile.gravatar}?s=300&d=https%3A%2F%2Ftesting.datahub.io%2Fstatic%2Fimg%2Flogo-cube03.png`

        const token = req.cookies.jwt
        // Get the latest available 10 events:
        const events = await api.getEvents(`owner="${req.cookies.username}"&size=10`, token)
        events.results = events.results.map(item => {
          item.timeago = timeago().format(item.timestamp)
          return item
        })
        const packages = await api.search(`datahub.ownerid="${req.cookies.id}"&size=0`, token)

        let storage, storagePublic, storagePrivate
        try {
          storage = await api.getStorage({owner: req.cookies.username})
          storagePrivate = await api.getStorage({owner: req.cookies.username, findability: 'private'})
          storagePublic = storage.totalBytes - storagePrivate.totalBytes
        } catch (err) {
          // Log the error but continue loading the page without storage info
          console.error(err)
        }

        res.render('dashboard.html', {
          title: 'Dashboard',
          profile: {username: req.cookies.username, email: req.cookies.email, plan: 'BASIC'},
          avatar,
          events: events.results,
          totalPackages: packages.summary.total,
          publicSpaceUsage: storagePublic ? bytes(storagePublic, {decimalPlaces: 0}) : 'N/A',
          privateSpaceUsage: storagePrivate ? bytes(storagePrivate.totalBytes, {decimalPlaces: 0}) : 'N/A',
          client
        })
      } else {
        req.flash('message', 'Your token has expired. Please, login to see your dashboard.')
        res.redirect('/')
      }
    } else {
      res.status(404).render('404.html', {message: 'Sorry, this page was not found'})
      return
    }
  })

  router.get('/login', async (req, res) => {
    const providers = await api.authenticate()
    const githubLoginUrl = providers.providers.github.url
    const googleLoginUrl = providers.providers.google.url
    res.render('login.html', {
      title: 'Sign up | Login',
      githubLoginUrl,
      googleLoginUrl
    })
  })

  router.get('/success', async (req, res) => {
    const jwt = req.query.jwt
    const isAuthenticated = await api.authenticate(jwt)
    const client = `login-${req.query.client}`
    if (isAuthenticated.authenticated) {
      req.session.client = client
      res.cookie('jwt', jwt)
      res.cookie('email', isAuthenticated.profile.email)
      res.cookie('id', isAuthenticated.profile.id)
      res.cookie('username', isAuthenticated.profile.username)
      res.redirect('/dashboard')
    } else {
      req.flash('message', 'Something went wrong. Please, try again later.')
      res.redirect('/')
    }
  })

  router.get('/logout', async (req, res) => {
    res.clearCookie('jwt')
    req.flash('message', 'You have been successfully logged out.')
    res.redirect('/')
  })

  // ==============
  // Docs (patterns, standards etc)

  async function showDoc (req, res) {
    if (req.params[0]) {
      const page = req.params[0]
      const BASE = 'https://raw.githubusercontent.com/datahq/datahub-content/master/'
      const filePath = 'docs/' + page + '.md'
      const gitpath = BASE + filePath
      const editpath = 'https://github.com/datahq/datahub-content/edit/master/' + filePath
      const resp = await fetch(gitpath)
      const text = await resp.text()
      const parsedWithFM = fm(text)
      const content = utils.md.render(parsedWithFM.body)
      const date = parsedWithFM.attributes.date
        ? moment(parsedWithFM.attributes.date).format('MMMM Do, YYYY')
        : null
      const githubPath = '//github.com/okfn/data.okfn.org/blob/master/' + path
      res.render('docs.html', {
        title: parsedWithFM.attributes.title,
        description: parsedWithFM.body.substring(0,200).replace(/\n/g, ' '),
        date,
        editpath: editpath,
        content,
        githubPath,
        metaImage: parsedWithFM.attributes.image,
        editable: parsedWithFM.attributes.editable
      })
    } else {
      res.render('docs_home.html', {
        title: 'Documentation',
        description: 'Learn how to use DataHub. Find out about DataHub features and read the tutorials.'
      })
    }
  }

  router.get(['/docs', '/docs/*'], showDoc)

  // ===== /end docs

  /** Awesome pages. http://datahub.io/awesome
   * For this section we will parse, render and
   * return pages from the awesome github repo:
   * https://github.com/datahubio/awesome
   */
  router.get(['/awesome', '/group'],redirectToDest("/collections"))
  router.get('/collections', (req, res) => {
    res.render('awesome-home.html', {
      title: 'Dataset Collections',
      description: 'Collections - high quality data and datasets organized by topic. Data Collections, Climate Change, Economic Data, Geodata, Inflation, Linked Open Data, Machine Learning, Reference Data, World Bank'
    })
  })

  router.get('/awesome/dashboards/:page', showAwesomeDashboardPage)
  router.get('/awesome/:page',  function (req,res){
    const page = '/collections/'+req.params.page
    res.redirect(page);
  })
  router.get('/collections/:page',showAwesomePage)


  async function showAwesomeDashboardPage(req, res) {
    const page = 'dashboards/' + req.params.page + '.html'
    res.render(page, { // attributes are hard coded for now since we have only dashboard:
      title: 'Climate Change Dashboard',
      description: 'State of the World and Impacts of Global Climate Change.'
    })
  }

  async function showAwesomePage(req, res) {
    const BASE = 'https://raw.githubusercontent.com/datahubio/awesome-data/master/'
    const path = req.params.page ? req.params.page + '.md' : 'README.md'
    //request raw page from github
    let gitpath = BASE + path
    let editpath = 'https://github.com/datahubio/awesome-data/edit/master/' + path
    const resp = await fetch(gitpath)
    const text = await resp.text()
    // parse the raw .md page and render it with a template.
    const parsedWithFrontMatter = fm(text)
    const published = parsedWithFrontMatter.attributes.date
    const modified = parsedWithFrontMatter.attributes.modified
    res.render('awesome.html', {
      title: parsedWithFrontMatter.attributes.title,
      page: req.params.page,
      editpath: editpath,
      description: parsedWithFrontMatter.attributes.description,
      content: utils.md.render(parsedWithFrontMatter.body),
      metaDescription: parsedWithFrontMatter.attributes.description + '\n' + parsedWithFrontMatter.attributes.keywords,
      keywords: parsedWithFrontMatter.attributes.keywords,
      metaImage: parsedWithFrontMatter.attributes.image,
      published: published ? published.toISOString() : '',
      modified: modified ? modified.toISOString() : '',
      editable: parsedWithFrontMatter.attributes.editable
    })
  }
  /* end awesome  */


  // ==============
  // Blog
  router.get('/blog', (req, res) => {
    const listOfPosts = []
    fs.readdirSync('blog/').forEach(post => {
      const filePath = `blog/${post}`
      const text = fs.readFileSync(filePath, 'utf8')
      let parsedWithFM = fm(text)
      parsedWithFM.body = utils.md.render(parsedWithFM.body)
      parsedWithFM.attributes.date = moment(parsedWithFM.attributes.date).format('MMMM Do, YYYY')
      parsedWithFM.attributes.authors = parsedWithFM.attributes.authors.map(author => authors[author])
      parsedWithFM.path = `blog/${post.slice(11, -3)}`
      listOfPosts.unshift(parsedWithFM)
    })
    res.render('blog.html', {
      title: 'Home',
      description: 'DataHub blog posts.',
      posts: listOfPosts
    })
  })

  router.get('/blog/:post', showPost)

  function showPost(req, res) {
    const page = req.params.post
    const fileName = fs.readdirSync('blog/').find(post => {
      return post.slice(11, -3) === page
    })
    if (fileName) {
      const filePath = `blog/${fileName}`
      fs.readFile(filePath, 'utf8', function(err, text) {
        if (err) throw err
        const parsedWithFM = fm(text)
        res.render('post.html', {
          title: parsedWithFM.attributes.title,
          description: parsedWithFM.body.substring(0,200).replace(/\n/g, ' '),
          date: moment(parsedWithFM.attributes.date).format('MMMM Do, YYYY'),
          authors: parsedWithFM.attributes.authors.map(author => authors[author]),
          content: utils.md.render(parsedWithFM.body),
          metaImage: parsedWithFM.attributes.image
        })
      })
    } else {
      res.status(404).render('404.html', {message: 'Sorry no post was found'})
      return
    }
  }
  const authors = {
    'rufuspollock': {name: 'Rufus Pollock', gravatar: md5('rufus.pollock@datopian.com'), username: 'rufuspollock'},
    'anuveyatsu': {name: 'Anuar Ustayev', gravatar: md5('anuar.ustayev@gmail.com'), username: 'anuveyatsu'},
    'zelima': {name: 'Irakli Mchedlishvili', gravatar: md5('irakli.mchedlishvili@datopian.com'), username: 'zelima1'},
    'mikanebu': {name: 'Meiran Zhiyenbayev', gravatar: md5('meiran1991@gmail.com'), username: 'Mikanebu'},
    'akariv': {name: 'Adam Kariv', gravatar: md5('adam.kariv@gmail.com'), username: 'akariv'},
    'acckiygerman': {name: 'Dmitry German', gravatar: md5('dmitry.german@datopian.com'), username: 'AcckiyGerman'},
    'branko-dj': {name: 'Branko Djordjevic', gravatar: md5('brankodj89@gmail.com'), username: 'Branko-Dj'},
    'svetozarstojkovic': {name: 'Svetozar Stojkovic', gravatar: md5('svetozar.cvele.stojkovic@gmail.com'), username: 'svetozarstojkovic'}
  }
  // ===== /end blog

  // Function for rendering showcase page:
  function renderShowcase() {
    return async (req, res, next) => {
      // Sometimes we're getting situation when owner is undefined, we want to return in such situations:
      if (!req.params.owner) return
      let token = req.cookies.jwt ? req.cookies.jwt : req.query.jwt

      let normalizedDp = null
      let failedPipelines = []

      try {
        normalizedDp = await api.getPackage(req.params.owner, req.params.name, token)
      } catch (err) {
        next(err)
        return
      }

      // Since "frontend-showcase-js" library renders views according to
      // descriptor's "views" property, we need to include "preview" views:
      normalizedDp.views = normalizedDp.views || []
      normalizedDp.resources.forEach(resource => {
        const view = {
          datahub: {
            type: 'preview'
          },
          resources: [
             resource.name
          ],
          specType: 'table'
        }
        normalizedDp.views.push(view)
      })

      renderPage(normalizedDp)

      async function renderPage(dp) {
        // Check if views are available so we can set meta image tags:
        let metaImage
        if (normalizedDp.resources.length <= normalizedDp.views.length) {
          // This means views have regular views on top of preview views:
          metaImage = `${config.get('SITE_URL')}/${req.params.owner}/${normalizedDp.name}/view/0.png`
        }

        // Now render the page:
        res.render('showcase.html', {
          title: req.params.owner + ' | ' + req.params.name,
          dataset: dp,
          owner: req.params.owner,
          // eslint-disable-next-line no-useless-escape, quotes
          dpId: JSON.stringify(dp).replace(/\\/g, '\\\\').replace(/\'/g, "\\'"),
          metaImage
        })
      }
    }
  }

  router.get('/tools/validate', async (req, res) => {
    let dataset
    let loading_error

    if (req.query.q){
      try {
        dataset = await datapackage.Package.load(req.query.q)
      } catch (err) {
        loading_error = true
      }
    }

    res.render('validate.html', {
      title: 'Validate Datasets',
      description: 'Data Package Validator. The online validator checks the data package descriptor (also known as datapackage.json file).',
      query: req.query.q,
      dataset,
      loading_error,
    })
  })

  router.get('/:owner/:name', renderShowcase())

  router.get('/:owner/:name/r/:fileNameOrIndex', async (req, res, next) => {
    let normalizedDp = null
    let token = req.cookies.jwt ? req.cookies.jwt : req.query.jwt
    const userAndPkgId = await api.resolve(
      slash(path.join(req.params.owner, req.params.name))
    )
    if (!userAndPkgId.userid) {
      res.status(404).render('404.html', {
        message: 'Sorry, this page was not found',
        comment: 'You might need to Login to access more datasets'
      })
      return
    }

    // Get the specific revision if id is given,
    // if not get the latest successful revision, if does not exist show 404
    let revisionId = req.query.v
    if (!revisionId) {
      let revisionStatus
      try {
        revisionStatus = await api.specStoreStatus(
          userAndPkgId.userid,
          userAndPkgId.packageid,
          'successful'
        )
      } catch (err) {
        next(err)
        return
      }
      revisionId = revisionStatus.id.split('/')[2]
    }

    try {
      normalizedDp = await api.getPackage(userAndPkgId.userid, userAndPkgId.packageid, revisionId, token)
    } catch (err) {
      next(err)
      return
    }

    const fileParts = path.parse(req.params.fileNameOrIndex)
    const extension = fileParts.ext
    const name = fileParts.name

    let resource
    // Check if file name is a number (check if zero explicitely as 0 evaluates to false in JS)
    if (parseInt(name, 10) || parseInt(name, 10) === 0) {
      // If number it still can be a file name not index so check it
      resource = normalizedDp.resources.find(res => res.name === name)
      // Otherwise get resource by index
      if (!resource) {
        resource = normalizedDp.resources[parseInt(name, 10)]
      }
    } else {
      // If name is not a number then just find resource by name
      resource = normalizedDp.resources.find(res => res.name === name)
    }
    // Check if resource was found and give 404 if not
    if (!resource) {
      res.status(404).render('404.html', {
        message: 'Sorry, we cannot locate that file for you'
      })
      return
    }

    // If resource is tabular or geojson + requested extension is HTML,
    // then render embeddable HTML table or map:
    const isTabular = resource.datahub && resource.datahub.type === 'derived/csv'
    if ((isTabular || resource.format === 'geojson') && extension.substring(1) === 'html') {
      // Prepare minified dp.json with the required resource:
      normalizedDp.resources = [resource]
      normalizedDp.views = []
      if (isTabular) { // For tabular resource we need to prepare 'preview' view:
        const preview = {
          "datahub": {
            "type": "preview"
          },
          "resources": [
            resource.name
          ],
          "specType": "table"
        }
        normalizedDp.views.push(preview)
      }
      // Handle private resources:
      if (normalizedDp.datahub.findability === 'private') {
        const authzToken = await api.authz(token)
        if (resource.alternates) {
          const previewResource = resource.alternates.find(res => res.datahub.type === 'derived/preview')
          if (previewResource) {
            previewResource.path = await getSignedUrl(previewResource.path)
          } else {
            resource.path = await getSignedUrl(resource.path)
          }
        } else {
          resource.path = await getSignedUrl(resource.path)
        }
      }
      // Render the page with stripped dp:
      res.render('view.html', {
        title: req.params.name,
        // eslint-disable-next-line no-useless-escape, quotes
        dpId: JSON.stringify(normalizedDp).replace(/\\/g, '\\\\').replace(/\'/g, "\\'")
      })
      return
    }

    // If resource was found then identify required format by given extension
    if (!(resource.format === extension.substring(1))) {
      if (resource.alternates) {
        resource = resource.alternates.find(res => (extension.substring(1) === res.format && res.datahub.type !== 'derived/preview'))
      }
      // If given format was not found then show 404
      if (!resource) {
        res.status(404).render('404.html', {
          message: 'Sorry, we cannot locate that file for you'
        })
        return
      }
    }

    async function getSignedUrl(path) {
      const authzToken = await api.authz(token)
      let resp = await fetch(path)
      if (resp.status === 403) {
        const signedUrl = await api.checkForSignedUrl(
          path, userAndPkgId.userid, null, authzToken
        )
        return signedUrl.url
      }
    }

    // If dataset's findability is private then get a signed url for the resource
    let finalPath = resource.path
    if (normalizedDp.datahub.findability === 'private') {
      finalPath = await getSignedUrl(finalPath)
    }

    res.header('Origin', req.protocol + '://' + req.get('host') + req.originalUrl)
    res.redirect(finalPath)
  })

  // Per view URL - PNG:
  router.get('/:owner/:name/view/:viewIndex.png', async (req, res, next) => {
    try {
      const options = {args: ['--no-sandbox', '--disable-setuid-sandbox']}
      const browser = await puppeteer.launch(options)
      const page = await browser.newPage()
      page.on('error', (err) => {
        console.log(`Puppetter error occurred on ${req.originalUrl}: ${err}`)
      })
      page.on('pageerror', (pageerr) => {
        console.log(`Puppetter pageerror occurred on ${req.originalUrl}: ${pageerr}`)
      })
      let source = `https://datahub.io/${req.params.owner}/${req.params.name}/view/${req.params.viewIndex}`
      if (req.query.v) {
        source += `?v=${req.query.v}`
      }
      page.setViewport({width: 1280, height: 800})
      await page.goto(source)
      await page.waitForSelector('svg', {timeout: 15000})
      const dims = await page.evaluate(() => {
        const svg = document.querySelector('svg').getBoundingClientRect()
        return {
          width: svg.width,
          height: svg.height
        }
      })
      page.setViewport(dims)
      const img = await page.screenshot({fullPage: true})
      await browser.close()
      res.writeHead(200, {
       'Content-Type': 'image/png',
       'Content-Length': img.length
      });
      return res.end(img)
    } catch (err) {
      if (err.message.includes('timeout')) {
        console.log(`Puppetter timeout (15s) occurred on ${req.originalUrl}`)
        err.status = 404
      }
      next(err)
      return
    }
  })

  // Per view URL - embed and share (caching response for 1 day or 1440 minutes):
  router.get('/:owner/:name/view/:viewNameOrIndex', cache(1440), async (req, res, next) => {
    let normalizedDp = null
    let token = req.cookies.jwt ? req.cookies.jwt : req.query.jwt
    const userAndPkgId = await api.resolve(
      slash(path.join(req.params.owner, req.params.name))
    )
    if (!userAndPkgId.userid) {
      res.status(404).render('404.html', {
        message: 'Sorry, this page was not found',
        comment: 'You might need to Login to access more datasets'
      })
      return
    }

    // Get the specific revision if id is given,
    // if not get the latest successful revision, if does not exist show 404
    let revisionId = req.query.v
    if (!revisionId) {
      let revisionStatus
      try {
        revisionStatus = await api.specStoreStatus(
          userAndPkgId.userid,
          userAndPkgId.packageid,
          'successful'
        )
      } catch (err) {
        next(err)
        return
      }
      revisionId = revisionStatus.id.split('/')[2]
    }

    try {
      normalizedDp = await api.getPackage(userAndPkgId.userid, userAndPkgId.packageid, revisionId, token)
    } catch (err) {
      next(err)
      return
    }

    // First try to find a view by name, e.g., if a number is given but view name is a number:
    // We're using "==" here as we want string '1' to be equal to number 1:
    let view = normalizedDp.views.find(item => item.name == req.params.viewNameOrIndex)
    // 'view' wasn't found, now get a view by index:
    view = view || normalizedDp.views[req.params.viewNameOrIndex]
    if (!view) { // 'view' wasn't found - return 404
      res.status(404).render('404.html', {
        message: 'Sorry, this page was not found'
      })
      return
    }
    // Replace original 'views' property with a single required 'view':
    normalizedDp.views = [view]

    if (view.resources) { // 'view' has 'resources' property then find required resources:
      const newResources = []
      view.resources.forEach(res => {
        if (res.constructor.name === 'Object') { // It's Object so use its 'name' property:
          res = res.name
        }
        let resource = normalizedDp.resources.find(item => item.name == res)
        resource = resource || normalizedDp.resources[res]
        newResources.push(resource)
      })
      // Replace original 'resources' property with a new list that is needed for the 'view':
      normalizedDp.resources = newResources
    } else { // Use only the first resource as by default:
      normalizedDp.resources = [normalizedDp.resources[0]]
    }

    // Handle private resources:
    if (normalizedDp.datahub.findability === 'private') {
      await Promise.all(normalizedDp.resources.map(async res => {
        let response = await fetch(res.path)
        if (response.status === 403) {
          const signedUrl = await api.checkForSignedUrl(
            res.path,
            userAndPkgId.userid,
            token
          )
          res.path = signedUrl.url
        }
      }))
    }

    // Render the page with stripped dp:
    res.render('view.html', {
      title: req.params.name,
      // eslint-disable-next-line no-useless-escape, quotes
      dpId: JSON.stringify(normalizedDp).replace(/\\/g, '\\\\').replace(/\'/g, "\\'")
    })
  })

  router.get('/:owner/:name/events', async (req, res, next) => {
    // First check if dataset exists
    const token = req.cookies.jwt
    const userAndPkgId = await api.resolve(
      slash(path.join(req.params.owner, req.params.name))
    )
    // Get the latest successful revision, if does not exist show 404
    let latestSuccessfulRevision
    try {
      latestSuccessfulRevision = await api.specStoreStatus(
        userAndPkgId.userid,
        userAndPkgId.packageid,
        'successful'
      )
    } catch (err) {
      next(err)
      return
    }
    const revisionId = latestSuccessfulRevision.id.split('/')[2]
    const response = await api.getPackageFile(userAndPkgId.userid, req.params.name, undefined, revisionId, token)
    if (response.status === 200) {
      const events = await api.getEvents(`owner="${req.params.owner}"&dataset="${req.params.name}"`, req.cookies.jwt)
      events.results = events.results.map(item => {
        item.timeago = timeago().format(item.timestamp)
        return item
      })
      res.render('events.html', {
        events: events.results,
        username: req.params.owner,
        dataset: req.params.name
      })
    } else if (response.status === 404) {
      res.status(404).render('404.html', {
        message: 'Sorry, this page was not found'
      })
    } else {
      next(response)
    }
  })

  router.get('/search', async (req, res) => {
    const token = req.cookies.jwt
    const from = req.query.from || 0
    const size = req.query.size || 20
    let topResults
    let query
    if (req.query.q) {
      query = `q="${req.query.q}"&size=${size}&from=${from}`
      topResults = false
    } else {
      topResults=true
    }
    const packages = await api.search(`${query}`, token)
    const total = packages.summary.total
    const totalPages = Math.ceil(total/size)
    const currentPage = parseInt(from, 10) / 20 + 1
    const pages = utils.pagination(currentPage, totalPages)

    res.render('search.html', {
      title: 'Search Datasets',
      description: 'Search for public datasets on DataHub. Quickly find data in various formats: csv, json, excel and more.',
      packages,
      pages,
      currentPage,
      query: req.query.q,
      defaultSearch: topResults
    })
  })

  router.get('/pricing', (req, res) => {
    res.render('pricing.html', {
      title: 'Pricing',
      description: 'Membership Plans on DataHub'
    })
  })

  router.get('/data-factory', (req, res) => {
    res.render('data-factory.html', {
      title: 'Data Factory',
      description: 'Data Factory - Automate your data processes with our open source framework.'
    })
  })

  router.get('/requests', (req, res) => {
    res.render('requests.html', {
      title: 'Data Requests',
      description: 'Engage the Data Concierge. We offer a service to locate and/or prepare data for you.'
    })
  })

  // Download page
  router.get('/tools', async (req, res) => {
    let desktopAppUrl, binReleaseMacos, binReleaseLinux, binReleaseWindows, etagForDesktop, etagForBinary, msiX64, msiX86

    if (req.app.locals.github) {
      etagForDesktop = req.app.locals.github.releases.desktop
        ? req.app.locals.github.releases.desktop.etag : ''
      etagForBinary = req.app.locals.github.releases.binary
        ? req.app.locals.github.releases.binary.etag : ''
    } else {
      req.app.locals.github = {releases: {}}
    }

    const desktopReleaseModified = await fetch('https://api.github.com/repos/datahq/data-desktop/releases/latest', {
      method: 'GET',
      headers: {'If-None-Match': etagForDesktop}
    })
    const binaryReleaseModified = await fetch('https://api.github.com/repos/datahq/data-cli/releases/latest', {
      method: 'GET',
      headers: {'If-None-Match': etagForBinary}
    })

    if (desktopReleaseModified.status === 304) { // No new release
      desktopAppUrl = req.app.locals.github.releases.desktop.url
    } else { // Go and get new release
      let desktopRelease = await fetch('https://api.github.com/repos/datahq/data-desktop/releases/latest')
      if (desktopRelease.status === 200) {
        const etag = desktopRelease.headers.get('ETag').slice(2)
        // Now get URL for downloading dekstop app:
        desktopRelease = await desktopRelease.json()
        desktopAppUrl = desktopRelease.assets
          .find(asset => path.parse(asset.name).ext === '.dmg')
          .browser_download_url
        // Update desktop release in the app.locals:
        const newRelease = {
          desktop: {
            etag,
            url: desktopAppUrl
          }
        }
        req.app.locals.github.releases = Object.assign(
          req.app.locals.github.releases,
          newRelease
        )
      } else { // If github api is unavailable then just have a link to releases page
        desktopAppUrl = 'https://github.com/datahq/data-desktop/releases'
      }
    }

    if (binaryReleaseModified.status === 304) { // No new release
      binReleaseMacos = req.app.locals.github.releases.binary.macos
      binReleaseLinux = req.app.locals.github.releases.binary.linux
      binReleaseWindows = req.app.locals.github.releases.binary.windows
      msiX64 = req.app.locals.github.releases.binary.msiX64
      msiX86 = req.app.locals.github.releases.binary.msiX86
    } else { // Go and get new release
      let binRelease = await fetch('https://api.github.com/repos/datahq/data-cli/releases/latest')
      if (binRelease.status === 200) {
        const etag = binRelease.headers.get('ETag').slice(2)
        // Now get URLs for downloading binaries:
        binRelease = await binRelease.json()
        binReleaseMacos = binRelease.assets
          .find(asset => asset.name.includes('macos.gz'))
          .browser_download_url
        binReleaseLinux = binRelease.assets
          .find(asset => asset.name.includes('linux.gz'))
          .browser_download_url
        binReleaseWindows = binRelease.assets
          .find(asset => asset.name.includes('win.exe.gz'))
          .browser_download_url
        msiX64 = binRelease.assets
          .find(asset => asset.name.includes('data-x64'))
          .browser_download_url
        msiX86 = binRelease.assets
          .find(asset => asset.name.includes('data-x86'))
          .browser_download_url
        // If msi isn't available yet, use previous version:
        msiX64 = msiX64 || req.app.locals.github.releases.binary.msiX64
        msiX86 = msiX86 || req.app.locals.github.releases.binary.msiX86
        // Update binary release in the app.locals:
        const newRelease = {
          binary: {
            etag,
            macos: binReleaseMacos,
            linux: binReleaseLinux,
            windows: binReleaseWindows,
            msiX64,
            msiX86
          }
        }
        req.app.locals.github.releases = Object.assign(
          req.app.locals.github.releases,
          newRelease
        )
      } else { // If github api is unavailable then just have a link to releases page
        binReleaseMacos = 'https://github.com/datahq/data-cli/releases'
        binReleaseLinux = 'https://github.com/datahq/data-cli/releases'
        binReleaseWindows = 'https://github.com/datahq/data-cli/releases'
        msiX64 = 'https://github.com/datahq/data-cli/releases'
        msiX86 = 'https://github.com/datahq/data-cli/releases'
      }
    }

    res.render('download.html', {
      title: 'Download',
      description: 'Command line tool for data wrangling. Download the tool for your OS (linux, mac or windows) and start wrangling, sharing and publishing your data online.',
      desktopAppUrl,
      binReleaseMacos,
      binReleaseLinux,
      binReleaseWindows,
      msiX64,
      msiX86
    })
  })

  // Consulting page
  router.get('/hire-us', async (req, res) => {
    res.render('consulting.html', {
      title: 'Hire Us ',
      description: 'We are a team with excellence and beyond. Hire us to build and improve your data-driven project. We have decades of experience building data systems for clients large and small.'
    })
  })

  // Premium data
  router.get('/premium-data', async (req, res) => {
    const submitted = !!(req.query.done)
    if (submitted) {
      const visitor = ua('UA-80458846-4')
      visitor.event('Premium data form submissions', 'success', req.query.parent).send()
    }
    res.render('premium-data.html', {
      title: "Premium data",
      submitted
    })
  })

  // Thank you page
  router.get('/thanks', async (req, res) => {
    const dest = req.query.next ? `/${req.query.next}` : '/'
    req.flash('message', 'Thank you! We\'ve recieved your request and will get back to you soon!')
    res.redirect(dest)
  })

  //Payments Page
  router.get('/pay', (req, res) => {
    let paymentSucceeded, amount
    if (req.query.amount) {
      amount = req.query.amount
    } else if (req.query.success) {
      paymentSucceeded = req.query.success
    } else {
      res.status(404).render('404.html', {
        message: 'Sorry, this page was not found'
      })
      return
    }

    res.render('pay.html', {
       getPayment: true,
       publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
       amount,
       paymentSucceeded
    })
  })

  //Payment Charging the amount
  router.post('/pay/checkout',(req,res) => {
      var token = req.body.stripeToken
      var chargeAmount = req.body.chargeAmount

      const charge = stripe.charges.create({
        amount: chargeAmount,
        currency: 'usd',
        description: 'Data Requests',
        source: token,
      }, (err, charge) => {
        if(err){
          req.flash('message', err.message)
          res.redirect('/pay?success=0')
        } else {
          res.redirect('/pay?success=1')
        }
      })
  })



  // MUST come last in order to catch all the publisher pages
  router.get('/:owner', async (req, res) => {
    // First check if user exists using resolver
    const userProfile = await api.getProfile(req.params.owner)
    if (!userProfile.found) {
      res.status(404).render('404.html', {
        message: 'Sorry, this page was not found'
      })
      return
    }

    const token = req.cookies.jwt
    // Get the latest available 10 events:
    const events = await api.getEvents(`owner="${req.params.owner}"&size=10`, token)
    events.results = events.results.map(item => {
      item.timeago = timeago().format(item.timestamp)
      return item
    })
    // Fetch information about the publisher:
    const joinDate = new Date(userProfile.profile.join_date)
    const joinYear = joinDate.getUTCFullYear()
    const joinMonth = joinDate.toLocaleString('en-us', { month: "long" })
    // Pagination - show 20 items per page:
    const from = req.query.from || 0
    const size = req.query.size || 20
    const query = req.query.q ? `&q="${req.query.q}"` : ''
    const packages = await api.search(`datahub.ownerid="${userProfile.profile.id}"${query}&size=${size}&from=${from}`, token)
    const total = packages.summary.total
    const totalPages = Math.ceil(total/size)
    const currentPage = parseInt(from, 10) / 20 + 1
    const pages = utils.pagination(currentPage, totalPages)
    let title, description = ''
    if (req.params.owner === 'core') {
      title = 'Core Datasets'
      description = 'Core datasets maintained by the DataHub team. Important, commonly-used data as high quality, easy-to-use & open data packages. Download data tables in csv (excel) and json.'
    } else if (req.params.owner === 'machine-learning') {
      title = 'Machine Learning Datasets'
      description = 'Machine Learning / Statistical Data. Examples of machine learning datasets. Machine learning data sets on the DataHub under the @machine-learning account.'
    } else {
      title = req.params.owner + ' datasets'
      description = userProfile.profile.name
    }
    const avatar = userProfile.profile.avatar_url || `https://www.gravatar.com/avatar/${userProfile.profile.gravatar}?s=300&d=https%3A%2F%2Ftesting.datahub.io%2Fstatic%2Fimg%2Flogo-cube03.png`
    res.render('owner.html', {
      title,
      description,
      packages,
      pages,
      currentPage,
      events: events.results,
      avatar,
      joinDate: joinMonth + ' ' + joinYear,
      owner: req.params.owner,
      name: userProfile.profile.name,
      queryString: req.query.q || '',
      query: req.query.q ? `&q=${req.query.q}` : ''
    })
  })

  return router
}
