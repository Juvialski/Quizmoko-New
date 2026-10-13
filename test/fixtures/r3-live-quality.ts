import sharp from 'sharp';
import {representativeSubset} from '../../scripts/evaluationSupport.ts';
/** Authoritative synthetic outcomes are independently specified; no student records or labels in prompts. */
export async function liveQualityFixtures(gold:any[]){
  const categories=['whole-number arithmetic','fractions','linear equations','multi-step word problems','geometry','trigonometry','coordinate geometry','statistics','probability','science','English grammar','exponents','algebra','percentages'];
  const positive=categories.map(category=>gold.find(q=>q.category===category)).filter(Boolean).map(q=>({...q,expected_answer:q.answer,expected_review:false}));
  const image=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="white"/><circle cx="50" cy="90" r="4"/><circle cx="170" cy="50" r="4"/><text x="50" y="115" font-size="18">A (1, 2)</text><text x="135" y="30" font-size="18">B (4, 3)</text></svg>')).png().toBuffer();
  const item=(id:string,category:string,question:string,options:string[],answer:string,expected_answer:string,expected_review:boolean)=>({id,category,question,options,answer,expected_answer,expected_review,type:'multiple_choice',solution:'The answer follows from the stated information.'});
  return [...positive,
    item('r3-visual','visual interpretation',`Read the printed coordinates in the image. What is the slope from A to B? <img src="data:image/png;base64,${image.toString('base64')}"/>`,['$1/3$','$3$','$-1/3$','$0$'],'A','A',false),
    item('r3-golden','incorrect source key','What is $2+3$?',['$4$','$5$','$6$','$7$'],'A','B',true),
    {...item('r3-ambiguous','ambiguous question','Which value is large?',['$2$','$3$','$4$','$5$'],'D','D',true),answer_scorable:false},
    item('r3-wrong','incorrect generated question','What is $3*4$?',['$10$','$11$','$12$','$13$'],'B','C',true),
    item('r3-duplicate','choice uniqueness','What is $1/2$?',['$0.5$','$1/2$','$2$','$3$'],'A','A',true),
    {...item('r3-explanation','mathematical explanations','What is $2+2$?',['$2$','$3$','$4$','$5$'],'C','C',true),solution:'$2+2=5$.'}
  ];
}
