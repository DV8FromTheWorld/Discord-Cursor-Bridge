const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Plugin to handle CSS modules and regular CSS
const cssPlugin = {
  name: 'css-plugin',
  setup(build) {
    // Track all CSS to combine at the end
    let cssContents = [];
    
    // Handle .module.css files (CSS modules)
    build.onLoad({ filter: /\.module\.css$/ }, async (args) => {
      const css = await fs.promises.readFile(args.path, 'utf8');
      const fileName = path.basename(args.path, '.module.css');
      
      // Simple CSS modules implementation - prefix all classes with file name
      const classMap = {};
      const processedCss = css.replace(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g, (match, className) => {
        const scopedName = `${fileName}_${className}`;
        classMap[className] = scopedName;
        return `.${scopedName}`;
      });
      
      cssContents.push(processedCss);
      
      return {
        contents: `export default ${JSON.stringify(classMap)};`,
        loader: 'js',
      };
    });
    
    // Handle regular .css files (global styles)
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      // Skip .module.css files (they're handled above)
      if (args.path.endsWith('.module.css')) {
        return null;
      }
      
      const css = await fs.promises.readFile(args.path, 'utf8');
      cssContents.push(css);
      
      return {
        contents: '/* global css loaded */',
        loader: 'js',
      };
    });
    
    // Reset CSS contents at build start
    build.onStart(() => {
      cssContents = [];
    });
    
    // After build, inject all CSS
    build.onEnd(async () => {
      if (cssContents.length > 0) {
        const allCss = cssContents.join('\n');
        const outfile = build.initialOptions.outfile;
        if (outfile && fs.existsSync(outfile)) {
          const js = await fs.promises.readFile(outfile, 'utf8');
          const cssInjector = `(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(allCss)};document.head.appendChild(s);})();`;
          await fs.promises.writeFile(outfile, cssInjector + '\n' + js);
        }
      }
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/index.tsx'],
    bundle: true,
    outfile: 'dist/webview.js',
    minify: production,
    sourcemap: !production,
    platform: 'browser',
    target: 'es2020',
    format: 'iife',
    plugins: [cssPlugin],
    loader: {
      '.tsx': 'tsx',
      '.ts': 'ts',
    },
    define: {
      'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
  });

  if (watch) {
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('Build complete');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
