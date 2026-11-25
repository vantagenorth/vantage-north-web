// Tailwind is compiled ahead of time into /assets/site.css, which is committed.
// After adding or changing Tailwind classes in any page, rebuild it:
//   npx tailwindcss@3.4.19 -c tailwind.config.js -i tailwind.input.css -o assets/site.css --minify
// The "Tailwind CSS is up to date" GitHub check fails if you forget.
module.exports = {
    content: ['./*.html', './terms/*.html', './pricing.js'],
    theme: {
        extend: {
            colors: {
                vnBg: '#FAFAFA',
                vnGray: '#646464',
                vnDarkGray: '#2B2B2B',
                vnBlack: '#000000',
                vnWhite: '#FFFFFF',
            },
            fontFamily: {
                urbanist: ['"Urbanist"', 'sans-serif'],
                epilogue: ['"Epilogue"', 'sans-serif'],
            },
        },
    },
};
