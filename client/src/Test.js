const api =() => {
  return new Promise((resolve, reject)=>{
    fetch("https://jsonplaceholder.typicode.com/posts")
      .then(response => response.json())
      .then(data=> resolve(data))               
      .catch(error => reject(error)) ;
  })
}
api()
  .then(data =>{
    console.log(data);
  })
  .catch(error=>{
    console.log(error);
  })