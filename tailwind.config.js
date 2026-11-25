// Tailwind is compiled at deploy time (npm run build) into /assets/site.css.
// Any class used in an HTML page or pricing.js is picked up automatically.
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
