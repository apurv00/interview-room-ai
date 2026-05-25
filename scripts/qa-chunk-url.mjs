#!/usr/bin/env node
/** Generate javascript: URLs to fetch QA report chunks from browser sessionStorage. */
const start = parseInt(process.argv[2] || '0', 10)
const end = parseInt(process.argv[3] || '49', 10)
const js = `(function(){for(var i=${start};i<=${end};i++){console.log('QA_CH|'+i+'|'+sessionStorage.getItem('qa_c_'+i))}})()`
console.log('javascript:void(' + js + ')')
